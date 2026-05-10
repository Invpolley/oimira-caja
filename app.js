// OiMira Caja — Logic
// Maneja: UI dinámica, cálculos, guardado local (IndexedDB), sync Supabase.

import { SUPABASE_URL, SUPABASE_ANON_KEY, CAJERA_DEFAULT, DEVICE_NAME } from './config.js';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================================
// Helpers de fecha LOCAL (no UTC) — crítico para usuarios en zonas tipo UTC-4
// Sin esto, cargar datos de noche hace que la fecha del día salte al siguiente
// porque toISOString() da UTC y ya puede estar en el día siguiente.
// ============================================================================
function todayLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ============================================================================
// Persistencia simple de la cajera en localStorage
// ============================================================================
const CAJERA_LS_KEY = "oimira_cajera";
function loadCajera() {
  try { return localStorage.getItem(CAJERA_LS_KEY) || CAJERA_DEFAULT; }
  catch { return CAJERA_DEFAULT; }
}
function saveCajera(nombre) {
  try { localStorage.setItem(CAJERA_LS_KEY, nombre); } catch {}
}

// ============================================================================
// Estado del formulario
// ============================================================================
// Tasas default (solo se usan si no hay tasa guardada del día; las del día son editables)
const TASA_BS_DEFAULT  = 0.0170;
const TASA_USD_DEFAULT = 5.10;

// Label visual vs nombre interno del catálogo
// "Dinheiro" es la key en la BD (dinheiro_rs) pero visualmente mostramos
// "Total venta efectivo" para que quede claro que es el BRUTO antes de gastos.
function displayIngresoName(nombre) {
  if (nombre === "Dinheiro") return "💵 Total venta efectivo";
  return nombre;
}

const state = {
  fecha: todayLocalISO(),
  cajera: loadCajera(),
  ingresos: [],   // [{nombre, moeda, monto, preset, id?}]
  gastos: [],     // [{descripcion, monto, moeda, categoria, id?}]
  sacosTrigo: 0,
  tickets: 0,
  observacoes: "",
  cierreId: null, // UUID del cierre actual (si ya existe en DB)
  transmittedAt: null,  // si está seteado = cierre oficialmente cerrado
  unlockUntil: 0,       // ms timestamp hasta cuando el modo edición sigue activo
  tasaBsRs:  TASA_BS_DEFAULT,   // 1 Bs = X R$ para este cierre
  tasaUsdRs: TASA_USD_DEFAULT,  // 1 USD = X R$ para este cierre
};

let categorias = [];   // catálogo de categorías de gastos
let ingresosCatalog = []; // catálogo de formas de pago

// ⚠ Fallback hardcoded: si Supabase no responde o el catálogo está vacío,
// usar estos 6 presets para que la UI nunca se quede sin inputs.
// Sincronizado con forma_pago_catalogo en BD (ver references/schema.md).
const INGRESOS_CATALOG_FALLBACK = [
  { nombre: "PIX",          moeda: "R$",  preset: true, orden: 1 },
  { nombre: "Dinheiro",     moeda: "R$",  preset: true, orden: 2 },
  { nombre: "Débito POS",   moeda: "R$",  preset: true, orden: 3 },
  { nombre: "Pago Móvil",   moeda: "Bs",  preset: true, orden: 4 },
  { nombre: "Bs efectivo",  moeda: "Bs",  preset: true, orden: 5 },
  { nombre: "USD",          moeda: "USD", preset: true, orden: 6 },
];

// ============================================================================
// IndexedDB para persistencia offline
// ============================================================================
const DB_NAME = "oimira_caja";
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains("drafts")) {
        d.createObjectStore("drafts", { keyPath: "fecha" });
      }
      if (!d.objectStoreNames.contains("queue")) {
        d.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e);
  });
}

async function saveDraft() {
  if (!db) return;
  const tx = db.transaction("drafts", "readwrite");
  tx.objectStore("drafts").put({ ...state, savedAt: Date.now() });
  updateLastSaved("Borrador guardado " + new Date().toLocaleTimeString());
}

async function loadDraft(fecha) {
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction("drafts", "readonly");
    const req = tx.objectStore("drafts").get(fecha);
    req.onsuccess = () => {
      const d = req.result;
      if (!d) return resolve(null);
      // ⚠ Validación de coherencia: si la fecha DENTRO del draft no coincide con la
      //   clave con la que se consultó, es un draft corrupto (legado del bug timezone UTC).
      //   Lo descartamos y borramos para evitar confusión.
      if (d.fecha && d.fecha !== fecha) {
        console.warn(`[loadDraft] Descartando draft corrupto: key=${fecha} pero contenido.fecha=${d.fecha}`);
        // Borrar en background, no esperar
        try {
          const tx2 = db.transaction("drafts", "readwrite");
          tx2.objectStore("drafts").delete(fecha);
        } catch {}
        return resolve(null);
      }
      resolve(d);
    };
    req.onerror = () => resolve(null);
  });
}

async function deleteDraft(fecha) {
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction("drafts", "readwrite");
    const req = tx.objectStore("drafts").delete(fecha);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
  });
}

// ============================================================================
// Online / offline status
// ============================================================================
function updateStatus() {
  const dot = document.getElementById("statusDot");
  const txt = document.getElementById("statusText");
  if (navigator.onLine) {
    dot.className = "inline-block w-2 h-2 rounded-full online-dot";
    txt.textContent = "Conectado";
  } else {
    dot.className = "inline-block w-2 h-2 rounded-full offline-dot";
    txt.textContent = "Offline";
  }
}
window.addEventListener("online", updateStatus);
window.addEventListener("offline", updateStatus);

// ============================================================================
// Render UI
// ============================================================================
function renderIngresos() {
  const list = document.getElementById("ingresosList");
  list.innerHTML = "";
  state.ingresos.forEach((ing, idx) => {
    const row = document.createElement("div");
    row.className = "ingreso-row";
    row.innerHTML = `
      <span class="label">${escapeHtml(displayIngresoName(ing.nombre))}</span>
      <span class="moeda">${ing.moeda}</span>
      <input type="number" inputmode="decimal" step="0.01" min="0"
             value="${ing.monto}" data-idx="${idx}" data-field="monto" />
      ${ing.preset ? '' : '<span class="delete-btn" data-idx="' + idx + '" data-action="del-ingreso">🗑</span>'}
    `;
    list.appendChild(row);
  });

  // Listeners
  list.querySelectorAll('input[data-field="monto"]').forEach(inp => {
    // Autoseleccionar contenido al enfocar (fix del "0" que no se reemplaza)
    inp.addEventListener("focus", (e) => e.target.select());
    inp.addEventListener("input", (e) => {
      const i = parseInt(e.target.dataset.idx);
      state.ingresos[i].monto = parseFloat(e.target.value) || 0;
      updateTotals();
      saveDraft();
    });
  });
  list.querySelectorAll('[data-action="del-ingreso"]').forEach(btn => {
    btn.addEventListener("click", (e) => {
      const i = parseInt(e.target.dataset.idx);
      state.ingresos.splice(i, 1);
      renderIngresos();
      updateTotals();
      saveDraft();
    });
  });
}

function renderGastos() {
  const list = document.getElementById("gastosList");
  list.innerHTML = "";
  state.gastos.forEach((g, idx) => {
    const card = document.createElement("div");
    card.className = "gasto-card";
    const catOptions = categorias.map(c =>
      `<option value="${escapeHtml(c.nombre)}" ${g.categoria === c.nombre ? 'selected' : ''}>${escapeHtml(c.nombre)}</option>`
    ).join('');

    card.innerHTML = `
      <span class="delete-btn" data-idx="${idx}">🗑</span>
      <input type="text" class="descripcion" placeholder="Descripción (ej. Entrega Pedro, Taxi, Agua)"
             value="${escapeHtml(g.descripcion)}" data-idx="${idx}" data-field="descripcion" />
      <div class="row">
        <input type="number" inputmode="decimal" step="0.01" min="0" class="monto"
               value="${g.monto}" data-idx="${idx}" data-field="monto" placeholder="0,00" />
        <select data-idx="${idx}" data-field="moeda">
          <option value="R$" ${g.moeda === 'R$' ? 'selected' : ''}>R$</option>
          <option value="Bs" ${g.moeda === 'Bs' ? 'selected' : ''}>Bs</option>
          <option value="USD" ${g.moeda === 'USD' ? 'selected' : ''}>US$</option>
        </select>
        <select data-idx="${idx}" data-field="categoria">
          ${catOptions}
        </select>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('[data-field]').forEach(el => {
    if (el.tagName === "INPUT" && el.type === "number") {
      el.addEventListener("focus", (e) => e.target.select());
    }
    el.addEventListener("input", (e) => updateGastoField(e));
    el.addEventListener("change", (e) => updateGastoField(e));
  });
  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener("click", (e) => {
      const i = parseInt(e.target.dataset.idx);
      state.gastos.splice(i, 1);
      renderGastos();
      updateTotals();
      saveDraft();
    });
  });
}

function updateGastoField(e) {
  const i = parseInt(e.target.dataset.idx);
  const field = e.target.dataset.field;
  const val = field === "monto" ? parseFloat(e.target.value) || 0 : e.target.value;
  state.gastos[i][field] = val;
  updateTotals();
  saveDraft();
}

function updateTotals() {
  const sumRsIng = state.ingresos.filter(i => i.moeda === "R$").reduce((s, i) => s + (i.monto || 0), 0);
  const sumBsIng = state.ingresos.filter(i => i.moeda === "Bs").reduce((s, i) => s + (i.monto || 0), 0);
  const sumUsdIng = state.ingresos.filter(i => i.moeda === "USD").reduce((s, i) => s + (i.monto || 0), 0);
  const sumRsGas = state.gastos.filter(g => g.moeda === "R$").reduce((s, g) => s + (g.monto || 0), 0);
  const sumBsGas = state.gastos.filter(g => g.moeda === "Bs").reduce((s, g) => s + (g.monto || 0), 0);
  const sumUsdGas = state.gastos.filter(g => g.moeda === "USD").reduce((s, g) => s + (g.monto || 0), 0);

  const netoRs = sumRsIng - sumRsGas;
  const netoBs = sumBsIng - sumBsGas;
  const netoUsd = sumUsdIng - sumUsdGas;

  // Card principal destacada (resumen en vivo)
  setTxt("resVentaRs", fmt("R$", sumRsIng));
  setTxt("resVentaBs", fmt("Bs", sumBsIng));
  setTxt("resVentaUsd", fmt("US$", sumUsdIng));
  setTxt("resGastoRs", fmt("R$", sumRsGas));
  setTxt("resGastoBs", fmt("Bs", sumBsGas));
  setTxt("resGastoUsd", fmt("US$", sumUsdGas));
  setTxt("resNetoRs", fmt("R$", netoRs));
  setTxt("resNetoBs", fmt("Bs", netoBs));
  setTxt("resNetoUsd", fmt("US$", netoUsd));
  colorNeto("resNetoRs", netoRs);
  colorNeto("resNetoBs", netoBs);
  colorNeto("resNetoUsd", netoUsd);
  // Banner rojo si algún neto es negativo
  const banner = document.getElementById("negativoBanner");
  if (banner) {
    banner.classList.toggle("hidden", !(netoRs < 0 || netoBs < 0 || netoUsd < 0));
  }

  // === Gran Total Venta consolidado en R$ + Efectivo que queda ===
  const tbs = Number(state.tasaBsRs)  || TASA_BS_DEFAULT;
  const tusd = Number(state.tasaUsdRs) || TASA_USD_DEFAULT;

  // Venta bruta efectivo = el monto que la cajera puso en "Dinheiro" (ahora "Total venta efectivo")
  const ventaEfectivoBruta = state.ingresos
    .filter(i => i.nombre === "Dinheiro" && i.preset)
    .reduce((s, i) => s + (Number(i.monto) || 0), 0);

  // Efectivo que queda físico = venta efectivo bruta - gastos R$
  const efectivoQueda = ventaEfectivoBruta - sumRsGas;

  // Gran total venta = todas las ventas convertidas a R$
  const granTotalVenta = sumRsIng + (sumBsIng * tbs) + (sumUsdIng * tusd);

  setTxt("granTotalVenta", fmt("R$", granTotalVenta));
  const efqEl = document.getElementById("efectivoQueda");
  if (efqEl) {
    efqEl.textContent = fmt("R$", efectivoQueda);
    efqEl.className = "text-xl mono font-black " + (efectivoQueda < 0 ? "text-red-700" : "text-amber-900");
  }

  // Preview de tasas (labels "1 Bs = X R$")
  setTxt("tasaBsPreview", tbs.toLocaleString("pt-BR", {minimumFractionDigits: 4, maximumFractionDigits: 4}));
  setTxt("tasaUsdPreview", tusd.toLocaleString("pt-BR", {minimumFractionDigits: 4, maximumFractionDigits: 4}));

  // Warning si faltan tasas con montos
  const hayBsSinTasa  = (sumBsIng > 0 || sumBsGas > 0) && tbs  === 0;
  const hayUsdSinTasa = (sumUsdIng > 0 || sumUsdGas > 0) && tusd === 0;
  const tw = document.getElementById("tasaWarning");
  if (tw) tw.classList.toggle("hidden", !(hayBsSinTasa || hayUsdSinTasa));

  // Card de totales detallada (la que ya existía)
  document.getElementById("totRsIng").textContent = fmt("R$", sumRsIng);
  document.getElementById("totBsIng").textContent = fmt("Bs", sumBsIng);
  document.getElementById("totRsGas").textContent = "-" + fmt("R$", sumRsGas);
  document.getElementById("totBsGas").textContent = "-" + fmt("Bs", sumBsGas);
  document.getElementById("netoRs").textContent = fmt("R$", netoRs);
  document.getElementById("netoBs").textContent = fmt("Bs", netoBs);
}

function setTxt(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function colorNeto(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("text-green-700","text-red-700","text-gray-700");
  el.classList.add(val > 0 ? "text-green-700" : val < 0 ? "text-red-700" : "text-gray-700");
}

function fmt(moeda, n) {
  return `${moeda} ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

// ============================================================================
// Carga inicial
// ============================================================================
async function loadCatalog() {
  // Categorías
  try {
    const { data: cats, error: e1 } = await supabase
      .from('categoria_gasto')
      .select('*')
      .eq('activo', true)
      .order('orden');
    if (!e1 && cats && cats.length > 0) categorias = cats;
  } catch (e) { console.warn("loadCatalog categorias error:", e); }

  // Formas de pago
  try {
    const { data: fps, error: e2 } = await supabase
      .from('forma_pago_catalogo')
      .select('*')
      .eq('activo', true)
      .order('orden');
    if (!e2 && fps && fps.length > 0) ingresosCatalog = fps;
  } catch (e) { console.warn("loadCatalog formas_pago error:", e); }

  // ⚠ Si después del fetch ingresosCatalog sigue vacío, usar fallback hardcoded
  if (!ingresosCatalog || ingresosCatalog.length === 0) {
    console.warn("⚠ Supabase no devolvió formas de pago — usando fallback hardcoded");
    ingresosCatalog = INGRESOS_CATALOG_FALLBACK.slice();
  }

  // Poblar ingresos preset si no hay nada cargado
  ensureIngresosPresets();
}

/**
 * Garantiza que los ingresos preset (PIX, Dinheiro, Débito, Pago Móvil, Bs, USD)
 * estén siempre visibles en la UI.
 * - Si state.ingresos está vacío → pobla todos los presets con monto 0
 * - Si ya tiene algunos → añade los presets que falten (mantiene los extras custom)
 */
function ensureIngresosPresets() {
  // Si el catálogo viene vacío (fetch aún no terminó o falló), usar fallback
  const source = (ingresosCatalog && ingresosCatalog.length > 0)
    ? ingresosCatalog
    : INGRESOS_CATALOG_FALLBACK;

  const existingPresets = new Set(
    state.ingresos.filter(i => i.preset).map(i => i.nombre)
  );
  const missing = source
    .filter(fp => fp.preset && !existingPresets.has(fp.nombre))
    .map(fp => ({
      nombre: fp.nombre, moeda: fp.moeda, monto: 0, preset: fp.preset,
    }));
  if (missing.length > 0) {
    // Agregar los faltantes al principio para que aparezcan en orden
    state.ingresos = [...missing, ...state.ingresos];
  }
}

async function loadExistingCierre() {
  // Intentar traer el cierre del día si ya existe
  const { data, error } = await supabase
    .from('dia_cierre')
    .select('*, forma_pago_extra(*), dia_gasto(*)')
    .eq('fecha', state.fecha)
    .maybeSingle();

  if (error || !data) return;

  state.cierreId = data.id;
  state.cajera = data.cajera || CAJERA_DEFAULT;
  state.sacosTrigo = data.sacos_trigo || 0;
  state.tickets = data.tickets || 0;
  state.observacoes = data.observacoes || "";
  state.transmittedAt = data.transmitted_at || null;  // null = borrador, timestamp = cerrado
  // Tasas históricas del cierre (inmutables): si no hay, usar defaults
  state.tasaBsRs  = data.tasa_bs_rs  != null ? Number(data.tasa_bs_rs)  : TASA_BS_DEFAULT;
  state.tasaUsdRs = data.tasa_usd_rs != null ? Number(data.tasa_usd_rs) : TASA_USD_DEFAULT;

  // Rellenar ingresos preset
  state.ingresos = ingresosCatalog.map(fp => {
    const fieldMap = {
      'PIX': 'pix_rs', 'Débito POS': 'debito_rs',
      'Pago Móvil': 'pago_movil_bs', 'Bs efectivo': 'bs_efectivo_bs',
      'USD': 'usd_usd'
    };
    let monto = 0;
    if (fp.nombre === "Dinheiro") {
      // "Dinheiro" en UI = venta efectivo BRUTA.
      // Lee ventas_efectivo_rs (campo nuevo); legacy fallback a dinheiro_rs si vacío/0.
      const ve = Number(data.ventas_efectivo_rs || 0);
      monto = ve > 0 ? ve : Number(data.dinheiro_rs || 0);
    } else {
      const field = fieldMap[fp.nombre];
      monto = field ? (data[field] || 0) : 0;
    }
    return { nombre: fp.nombre, moeda: fp.moeda, monto, preset: fp.preset };
  });

  // Agregar formas de pago extra
  (data.forma_pago_extra || []).forEach(fpe => {
    state.ingresos.push({
      nombre: fpe.nombre, moeda: fpe.moeda, monto: fpe.monto || 0,
      preset: false, id: fpe.id
    });
  });

  // Gastos
  state.gastos = (data.dia_gasto || []).map(g => ({
    id: g.id,
    descripcion: g.descripcion,
    monto: g.monto || 0,
    moeda: g.moeda,
    categoria: g.categoria,
  }));
}

function bindStatic() {
  // Fecha
  const fechaInput = document.getElementById("fecha");
  fechaInput.value = state.fecha;
  fechaInput.addEventListener("change", async (e) => {
    state.fecha = e.target.value;
    state.cierreId = null;
    state.ingresos = [];
    state.gastos = [];
    state.transmittedAt = null;
    state.unlockUntil = 0;
    // Reset de tasas al default — si no, quedan pegadas las del día anterior
    // y se guardan en tasa_bs_rs/tasa_usd_rs aunque el cierre nuevo no las haya editado.
    state.tasaBsRs  = TASA_BS_DEFAULT;
    state.tasaUsdRs = TASA_USD_DEFAULT;
    if (_unlockTimer) { clearInterval(_unlockTimer); _unlockTimer = null; }

    // 1. Intentar cargar draft local (puede ser un día que la cajera dejó a medias)
    //    No dejamos que el draft pise state.cajera (viene de localStorage y es
    //    la cajera del turno actual, no la que estaba activa en el draft viejo).
    const draft = await loadDraft(state.fecha);
    if (draft) {
      const cajeraActual = state.cajera;
      Object.assign(state, draft);
      state.cajera = cajeraActual;
    }

    // 2. Si estamos online, chequear si ya hay cierre transmitido en la DB
    if (navigator.onLine) await loadExistingCierre();

    // 3. Garantizar que los presets (PIX, Dinheiro, Débito, Pago Móvil, Bs, USD)
    //    siempre estén visibles aunque no haya ni draft ni cierre en DB
    ensureIngresosPresets();

    // NOTA: ya NO bloqueamos "días anteriores sin transmisión" — esos quedan
    // editables como borradores legítimos (caso cajera cargando de mañana
    // los datos de la noche anterior). Solo bloquea transmitted_at real.
    renderAll();
    applyLockState();
  });

  // Cajera — con persistencia entre sesiones (localStorage)
  const cajeraSel = document.getElementById("cajera");
  // Si la cajera guardada no está en el select (ej. es un nombre custom viejo), agregarla
  if (state.cajera && ![...cajeraSel.options].some(o => o.value === state.cajera)) {
    const opt = document.createElement("option");
    opt.value = state.cajera; opt.textContent = state.cajera;
    cajeraSel.insertBefore(opt, cajeraSel.querySelector('option[value="Otra"]'));
  }
  cajeraSel.value = state.cajera;
  cajeraSel.addEventListener("change", (e) => {
    if (e.target.value === "Otra") {
      const nombre = prompt("Nombre de la cajera:");
      if (nombre) {
        state.cajera = nombre;
        const opt = document.createElement("option");
        opt.value = nombre; opt.textContent = nombre; opt.selected = true;
        cajeraSel.insertBefore(opt, cajeraSel.querySelector('option[value="Otra"]'));
      } else {
        // Si cancela el prompt, volver al valor anterior
        cajeraSel.value = state.cajera;
        return;
      }
    } else {
      state.cajera = e.target.value;
    }
    saveCajera(state.cajera);    // ← persistir entre sesiones
    saveDraft();
  });

  // Sacos / Tickets (con autoselect al tocar)
  const sacos = document.getElementById("sacosTrigo");
  sacos.addEventListener("focus", e => e.target.select());
  sacos.addEventListener("input", e => {
    state.sacosTrigo = parseInt(e.target.value) || 0; saveDraft();
  });
  const tickets = document.getElementById("tickets");
  tickets.addEventListener("focus", e => e.target.select());
  tickets.addEventListener("input", e => {
    state.tickets = parseInt(e.target.value) || 0; saveDraft();
  });

  // Observações
  document.getElementById("observacoes").addEventListener("input", e => {
    state.observacoes = e.target.value; saveDraft();
  });

  // Tasas de cambio del día
  const tasaBs = document.getElementById("tasaBsRs");
  if (tasaBs) {
    tasaBs.value = state.tasaBsRs;
    tasaBs.addEventListener("focus", e => e.target.select());
    tasaBs.addEventListener("input", e => {
      state.tasaBsRs = parseFloat(e.target.value) || 0;
      updateTotals();
      saveDraft();
    });
  }
  const tasaUsd = document.getElementById("tasaUsdRs");
  if (tasaUsd) {
    tasaUsd.value = state.tasaUsdRs;
    tasaUsd.addEventListener("focus", e => e.target.select());
    tasaUsd.addEventListener("input", e => {
      state.tasaUsdRs = parseFloat(e.target.value) || 0;
      updateTotals();
      saveDraft();
    });
  }

  // Agregar ingreso nuevo
  document.getElementById("addIngresoBtn").addEventListener("click", () => {
    const nombre = prompt("Nombre de la forma de pago (ej. iFood, Zelle):");
    if (!nombre) return;
    const moeda = prompt("Moeda (R$ o Bs):", "R$");
    if (!moeda || (moeda !== "R$" && moeda !== "Bs")) return;
    state.ingresos.push({ nombre, moeda, monto: 0, preset: false });
    renderIngresos();
    saveDraft();
  });

  // Agregar gasto
  document.getElementById("addGastoBtn").addEventListener("click", () => {
    state.gastos.push({
      descripcion: "",
      monto: 0,
      moeda: "R$",
      categoria: categorias[0]?.nombre || "Otro",
    });
    renderGastos();
    saveDraft();
  });

  // Guardar borrador manual
  document.getElementById("guardarBtn").addEventListener("click", () => {
    saveDraft();
    toast("✅ Borrador guardado localmente");
  });

  // Descartar borrador (borra de IndexedDB el draft de la fecha actual y resetea la UI)
  const descartarBtn = document.getElementById("descartarBtn");
  if (descartarBtn) {
    descartarBtn.addEventListener("click", async () => {
      if (!confirm("¿Descartar el borrador de " + state.fecha + "?\n\nSe borran solo los datos LOCALES no transmitidos. Los cierres ya cerrados en servidor no se tocan.")) return;
      await deleteDraft(state.fecha);
      // Resetear state de ingresos/gastos/tasas/campos
      state.ingresos = [];
      state.gastos = [];
      state.sacosTrigo = 0;
      state.tickets = 0;
      state.observacoes = "";
      state.cierreId = null;
      state.transmittedAt = null;
      state.unlockUntil = 0;
      // Re-cargar desde DB (por si hay cierre oficial que debe verse)
      if (navigator.onLine) await loadExistingCierre();
      // Asegurar presets visibles con monto 0
      ensureIngresosPresets();
      renderAll();
      applyLockState();
      toast("🗑 Borrador descartado — cargado de cero");
    });
  }

  // Enviar → primero confirmar
  document.getElementById("enviarBtn").addEventListener("click", openConfirmModal);

  // Desbloqueo
  document.getElementById("unlockBtn").addEventListener("click", openUnlockModal);
  document.getElementById("unlock_cancel").addEventListener("click", () => toggleModal("modalUnlock", false));
  document.getElementById("unlock_submit").addEventListener("click", submitUnlockCode);
  document.getElementById("unlock_code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitUnlockCode();
  });

  // Confirm modal
  document.getElementById("conf_cancelar").addEventListener("click", () => toggleModal("modalConfirmar", false));
  document.getElementById("conf_enviar").addEventListener("click", () => {
    toggleModal("modalConfirmar", false);
    enviarCierre(/*transmitir*/ true);
  });
  document.getElementById("conf_check").addEventListener("change", (e) => {
    document.getElementById("conf_enviar").disabled = !e.target.checked;
  });
}

// ============================================================
// Helpers de modal/lock/unlock
// ============================================================
function toggleModal(id, show) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("hidden", !show);
}

// Marcador de "día anterior sin cierre real"
const LOCK_MARKER_DIA_ANTERIOR = "1970-01-01T00:00:00Z";

function isLocked() {
  // Está bloqueado si el cierre ya fue transmitido Y el unlock no está vigente
  if (!state.transmittedAt) return false;
  return Date.now() > (state.unlockUntil || 0);
}

function applyLockState() {
  const locked = isLocked();
  const inUnlock = state.transmittedAt && Date.now() < (state.unlockUntil || 0);

  // Banner locked
  const lockedBanner = document.getElementById("lockedBanner");
  lockedBanner.classList.toggle("hidden", !locked);
  if (locked) {
    const esHoy = state.fecha === todayLocalISO();
    const esMarkerDiaAnterior = state.transmittedAt === LOCK_MARKER_DIA_ANTERIOR;

    if (esMarkerDiaAnterior) {
      // Día anterior, sin transmisión previa real
      document.getElementById("lockedBannerTitle").textContent = "📅 Día anterior";
      document.getElementById("lockedBannerSubtitle").textContent =
        "Estás viendo un día pasado. Para cargar o modificar datos, pedí un código al administrador.";
    } else {
      // Transmisión real
      const d = new Date(state.transmittedAt);
      const cuando = d.toLocaleString("es-AR");
      document.getElementById("lockedBannerTitle").textContent = esHoy
        ? "🔒 Cierre del día ya transmitido"
        : "🔒 Cierre de día anterior transmitido";
      document.getElementById("lockedBannerSubtitle").textContent =
        `Transmitido ${cuando}. Pedí un código al administrador para editar.`;
    }
  }

  // Banner unlocked con timer
  const unlockedBanner = document.getElementById("unlockedBanner");
  unlockedBanner.classList.toggle("hidden", !inUnlock);

  // Deshabilitar inputs
  const editables = document.querySelectorAll("#fecha, #sacosTrigo, #tickets, #observacoes, #addIngresoBtn, #addGastoBtn, #ingresosList input, #gastosList input, #gastosList select, #ingresosList button, #gastosList button, #enviarBtn, #guardarBtn");
  editables.forEach(el => {
    // fecha siempre se puede cambiar (para ver otros días)
    if (el.id === "fecha") return;
    if (locked) el.setAttribute("disabled", "true");
    else el.removeAttribute("disabled");
  });
}

// Timer del unlock
let _unlockTimer = null;
function startUnlockTimer() {
  if (_unlockTimer) clearInterval(_unlockTimer);
  _unlockTimer = setInterval(() => {
    const restante = state.unlockUntil - Date.now();
    if (restante <= 0) {
      clearInterval(_unlockTimer); _unlockTimer = null;
      state.unlockUntil = 0;
      applyLockState();
      toast("⏱ Modo edición expirado. Enviá si querés guardar cambios.");
      return;
    }
    const mm = Math.floor(restante / 60000);
    const ss = Math.floor((restante % 60000) / 1000);
    const el = document.getElementById("unlockedTimer");
    if (el) el.textContent = mm + ":" + String(ss).padStart(2, "0");
  }, 1000);
}

function openUnlockModal() {
  document.getElementById("unlock_code").value = "";
  document.getElementById("unlock_error").classList.add("hidden");
  toggleModal("modalUnlock", true);
  setTimeout(() => document.getElementById("unlock_code").focus(), 100);
}

async function submitUnlockCode() {
  const code = document.getElementById("unlock_code").value.trim();
  const errEl = document.getElementById("unlock_error");
  errEl.classList.add("hidden");
  if (!/^\d{6}$/.test(code)) {
    errEl.textContent = "El código debe tener 6 dígitos";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    const { data, error } = await supabase.rpc("consume_unlock_code", {
      p_code: code,
      p_fecha: state.fecha,
      p_cajera: state.cajera,
    });
    if (error) throw error;
    if (!data?.ok) {
      errEl.textContent = data?.error || "Código inválido";
      errEl.classList.remove("hidden");
      return;
    }
    // Unlock por 30 minutos
    state.unlockUntil = Date.now() + 30 * 60 * 1000;
    toggleModal("modalUnlock", false);
    applyLockState();
    startUnlockTimer();
    toast("✅ Desbloqueado por 30 minutos" + (data.descripcion ? " — " + data.descripcion : ""));
  } catch (e) {
    errEl.textContent = "Error de conexión: " + (e.message || e);
    errEl.classList.remove("hidden");
  }
}

// ============================================================
// Modal de confirmación de envío
// ============================================================
function openConfirmModal() {
  // Validar que haya algo que enviar
  const tieneIngresos = state.ingresos.some(i => Number(i.monto) > 0);
  const tieneGastos = state.gastos.some(g => Number(g.monto) > 0);
  if (!tieneIngresos && !tieneGastos && !state.sacosTrigo && !state.tickets) {
    toast("⚠️ No hay datos para cerrar");
    return;
  }

  const sumR = state.ingresos.filter(i => i.moeda === "R$").reduce((s, i) => s + (Number(i.monto) || 0), 0);
  const sumB = state.ingresos.filter(i => i.moeda === "Bs").reduce((s, i) => s + (Number(i.monto) || 0), 0);
  const sumU = state.ingresos.filter(i => i.moeda === "USD").reduce((s, i) => s + (Number(i.monto) || 0), 0);
  const gasR = state.gastos.filter(g => g.moeda === "R$").reduce((s, g) => s + (Number(g.monto) || 0), 0);
  const gasB = state.gastos.filter(g => g.moeda === "Bs").reduce((s, g) => s + (Number(g.monto) || 0), 0);
  const gasU = state.gastos.filter(g => g.moeda === "USD").reduce((s, g) => s + (Number(g.monto) || 0), 0);
  // Gran total venta consolidado en R$ usando las tasas del día
  const tbs  = Number(state.tasaBsRs)  || TASA_BS_DEFAULT;
  const tusd = Number(state.tasaUsdRs) || TASA_USD_DEFAULT;
  const granTotal = sumR + (sumB * tbs) + (sumU * tusd);
  const gastosTotalRs = gasR + (gasB * tbs) + (gasU * tusd);

  const fmt = (v, m) => m + " " + (Number(v) || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  document.getElementById("conf_fecha").textContent = state.fecha;
  document.getElementById("conf_cajera").textContent = state.cajera;
  document.getElementById("conf_ingR").textContent = fmt(sumR, "R$");
  document.getElementById("conf_ingB").textContent = fmt(sumB, "Bs");
  document.getElementById("conf_gasR").textContent = "− " + fmt(gasR, "R$");
  document.getElementById("conf_gasB").textContent = "− " + fmt(gasB, "Bs");
  document.getElementById("conf_tickets").textContent = state.tickets;
  document.getElementById("conf_sacos").textContent = state.sacosTrigo;
  document.getElementById("conf_check").checked = false;
  document.getElementById("conf_enviar").disabled = true;

  toggleModal("modalConfirmar", true);
}

function renderAll() {
  document.getElementById("fecha").value = state.fecha;
  document.getElementById("cajera").value = state.cajera;
  document.getElementById("sacosTrigo").value = state.sacosTrigo;
  document.getElementById("tickets").value = state.tickets;
  document.getElementById("observacoes").value = state.observacoes;
  const tb = document.getElementById("tasaBsRs");
  const tu = document.getElementById("tasaUsdRs");
  if (tb) tb.value = state.tasaBsRs;
  if (tu) tu.value = state.tasaUsdRs;
  renderIngresos();
  renderGastos();
  updateTotals();
}

// ============================================================================
// Enviar al Supabase
// ============================================================================
async function enviarCierre(transmitir = true) {
  const btn = document.getElementById("enviarBtn");
  btn.disabled = true;
  btn.textContent = "⏳ Enviando...";
  const dot = document.getElementById("statusDot");
  dot.className = "inline-block w-2 h-2 rounded-full syncing-dot";

  try {
    // Map preset ingresos a columnas de dia_cierre
    const getPreset = (nombre) => state.ingresos.find(i => i.nombre === nombre && i.preset)?.monto || 0;

    // Venta efectivo bruta (lo que la cajera cargó en "Total venta efectivo"/Dinheiro)
    const ventasEfectivoRs = getPreset('Dinheiro');
    // Gastos en R$ del día (para derivar el "dinheiro_rs" legacy = efectivo que queda)
    const gastosRs = state.gastos
      .filter(g => g.moeda === "R$")
      .reduce((s, g) => s + (Number(g.monto) || 0), 0);
    const dinheiroRsNeto = ventasEfectivoRs - gastosRs;

    const cierrePayload = {
      fecha: state.fecha,
      cajera: state.cajera,
      pix_rs: getPreset('PIX'),
      dinheiro_rs: dinheiroRsNeto,              // ⚠ legacy: efectivo neto que queda
      ventas_efectivo_rs: ventasEfectivoRs,      // nuevo: venta efectivo bruta
      debito_rs: getPreset('Débito POS'),
      pago_movil_bs: getPreset('Pago Móvil'),
      bs_efectivo_bs: getPreset('Bs efectivo'),
      usd_usd: getPreset('USD'),
      tasa_bs_rs:  Number(state.tasaBsRs)  || TASA_BS_DEFAULT,
      tasa_usd_rs: Number(state.tasaUsdRs) || TASA_USD_DEFAULT,
      sacos_trigo: state.sacosTrigo,
      tickets: state.tickets,
      observacoes: state.observacoes,
      device: DEVICE_NAME,
    };
    // Solo marcar transmitted_at cuando es confirmación oficial del cierre
    if (transmitir) {
      cierrePayload.transmitted_at = new Date().toISOString();
    }

    let cierreId = state.cierreId;

    if (cierreId) {
      // Update
      const { error } = await supabase.from('dia_cierre').update(cierrePayload).eq('id', cierreId);
      if (error) throw error;
    } else {
      // Insert (o upsert por fecha)
      const { data, error } = await supabase.from('dia_cierre')
        .upsert(cierrePayload, { onConflict: 'fecha' })
        .select()
        .single();
      if (error) throw error;
      cierreId = data.id;
      state.cierreId = cierreId;
    }

    // Borrar formas de pago extra existentes + gastos, luego reinsertar
    await supabase.from('forma_pago_extra').delete().eq('dia_cierre_id', cierreId);
    await supabase.from('dia_gasto').delete().eq('dia_cierre_id', cierreId);

    // Insert formas de pago extra (custom, no preset)
    const extras = state.ingresos
      .filter(i => !i.preset && i.monto > 0)
      .map(i => ({
        dia_cierre_id: cierreId,
        nombre: i.nombre,
        moeda: i.moeda,
        monto: i.monto,
      }));
    if (extras.length > 0) {
      const { error: e2 } = await supabase.from('forma_pago_extra').insert(extras);
      if (e2) throw e2;
    }

    // Insert gastos
    const gastos = state.gastos
      .filter(g => g.descripcion && g.monto > 0)
      .map(g => ({
        dia_cierre_id: cierreId,
        descripcion: g.descripcion,
        categoria: g.categoria,
        monto: g.monto,
        moeda: g.moeda,
      }));
    if (gastos.length > 0) {
      const { error: e3 } = await supabase.from('dia_gasto').insert(gastos);
      if (e3) throw e3;
    }

    if (transmitir) {
      state.transmittedAt = cierrePayload.transmitted_at;
      state.unlockUntil = 0; // consume el unlock si estaba activo
      applyLockState();
      toast("🔒 Día cerrado oficialmente. Solo editable con código de admin.");
    } else {
      toast("✅ Cierre enviado correctamente");
    }
    updateStatus();

  } catch (err) {
    console.error(err);
    toast("❌ Error: " + (err.message || err) + " — Guardado localmente, reintentar con internet");
    updateStatus();
  } finally {
    btn.disabled = false;
    btn.textContent = "📤 Enviar cierre del día";
  }
}

// ============================================================================
// Helpers UI
// ============================================================================
function toast(msg, ms = 4000) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), ms);
}

function updateLastSaved(text) {
  document.getElementById("lastSaved").textContent = text;
}

// ============================================================================
// Boot
// ============================================================================
(async () => {
  await openDB();
  updateStatus();

  // Pre-poblar presets con el fallback hardcoded ANTES de todo, para que
  // la UI muestre los 6 inputs aunque falle cualquier fetch posterior.
  ensureIngresosPresets();

  bindStatic();

  // Intentar cargar borrador local primero — pero proteger state.cajera
  // (viene de localStorage y refleja la cajera del turno actual; el draft puede
  // tener un nombre viejo de cuando se guardó).
  const draft = await loadDraft(state.fecha);
  if (draft) {
    const cajeraActual = state.cajera;
    Object.assign(state, draft);
    state.cajera = cajeraActual;
  }

  try {
    await loadCatalog();
    if (navigator.onLine) {
      await loadExistingCierre();
    }
  } catch (e) {
    console.warn("Error cargando catálogo:", e);
    toast("⚠️ Sin conexión — usando datos locales");
  }

  // Garantizar que los presets siempre estén visibles (PIX, Dinheiro, Débito, Pago Móvil, Bs, USD).
  // Esto protege contra: draft incompleto, fallo de fetch del catálogo, carga de cierre legacy sin todos los campos.
  ensureIngresosPresets();

  // NOTA: ya no bloqueamos "días pasados sin transmitir" automáticamente.
  // Solo bloquea lo que realmente tiene transmitted_at != null (cierre oficial).
  // Así la cajera puede continuar borradores del día anterior sin pedir código.

  renderAll();
  applyLockState();
})();

// Registrar Service Worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW fail:", err));
}
