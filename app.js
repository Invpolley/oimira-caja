// OiMira Caja — Logic
// Maneja: UI dinámica, cálculos, guardado local (IndexedDB), sync Supabase.

import { SUPABASE_URL, SUPABASE_ANON_KEY, CAJERA_DEFAULT, DEVICE_NAME } from './config.js';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================================
// Estado del formulario
// ============================================================================
const state = {
  fecha: new Date().toISOString().slice(0, 10),
  cajera: CAJERA_DEFAULT,
  ingresos: [],   // [{nombre, moeda, monto, preset, id?}]
  gastos: [],     // [{descripcion, monto, moeda, categoria, id?}]
  sacosTrigo: 0,
  tickets: 0,
  observacoes: "",
  cierreId: null, // UUID del cierre actual (si ya existe en DB)
};

let categorias = [];   // catálogo de categorías de gastos
let ingresosCatalog = []; // catálogo de formas de pago

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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
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
      <span class="label">${escapeHtml(ing.nombre)}</span>
      <span class="moeda">${ing.moeda}</span>
      <input type="number" inputmode="decimal" step="0.01" min="0"
             value="${ing.monto}" data-idx="${idx}" data-field="monto" />
      ${ing.preset ? '' : '<span class="delete-btn" data-idx="' + idx + '" data-action="del-ingreso">🗑</span>'}
    `;
    list.appendChild(row);
  });

  // Listeners
  list.querySelectorAll('input[data-field="monto"]').forEach(inp => {
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
        </select>
        <select data-idx="${idx}" data-field="categoria">
          ${catOptions}
        </select>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('[data-field]').forEach(el => {
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
  const sumRsGas = state.gastos.filter(g => g.moeda === "R$").reduce((s, g) => s + (g.monto || 0), 0);
  const sumBsGas = state.gastos.filter(g => g.moeda === "Bs").reduce((s, g) => s + (g.monto || 0), 0);

  document.getElementById("totRsIng").textContent = fmt("R$", sumRsIng);
  document.getElementById("totBsIng").textContent = fmt("Bs", sumBsIng);
  document.getElementById("totRsGas").textContent = "-" + fmt("R$", sumRsGas);
  document.getElementById("totBsGas").textContent = "-" + fmt("Bs", sumBsGas);
  document.getElementById("netoRs").textContent = fmt("R$", sumRsIng - sumRsGas);
  document.getElementById("netoBs").textContent = fmt("Bs", sumBsIng - sumBsGas);
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
  const { data: cats, error: e1 } = await supabase
    .from('categoria_gasto')
    .select('*')
    .eq('activo', true)
    .order('orden');
  if (!e1 && cats) categorias = cats;

  // Formas de pago
  const { data: fps, error: e2 } = await supabase
    .from('forma_pago_catalogo')
    .select('*')
    .eq('activo', true)
    .order('orden');
  if (!e2 && fps) ingresosCatalog = fps;

  // Poblar ingresos preset si no hay nada cargado
  if (state.ingresos.length === 0) {
    state.ingresos = ingresosCatalog.map(fp => ({
      nombre: fp.nombre,
      moeda: fp.moeda,
      monto: 0,
      preset: fp.preset,
    }));
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

  // Rellenar ingresos preset
  state.ingresos = ingresosCatalog.map(fp => {
    const fieldMap = {
      'PIX': 'pix_rs', 'Dinheiro': 'dinheiro_rs', 'Débito POS': 'debito_rs',
      'Pago Móvil': 'pago_movil_bs', 'Bs efectivo': 'bs_efectivo_bs'
    };
    const field = fieldMap[fp.nombre];
    return {
      nombre: fp.nombre, moeda: fp.moeda,
      monto: field ? (data[field] || 0) : 0,
      preset: fp.preset,
    };
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
    await loadExistingCierre();
    renderAll();
  });

  // Cajera
  const cajeraSel = document.getElementById("cajera");
  cajeraSel.value = state.cajera;
  cajeraSel.addEventListener("change", (e) => {
    if (e.target.value === "Otra") {
      const nombre = prompt("Nombre de la cajera:");
      if (nombre) {
        state.cajera = nombre;
        const opt = document.createElement("option");
        opt.value = nombre; opt.textContent = nombre; opt.selected = true;
        cajeraSel.appendChild(opt);
      }
    } else {
      state.cajera = e.target.value;
    }
    saveDraft();
  });

  // Sacos / Tickets
  document.getElementById("sacosTrigo").addEventListener("input", e => {
    state.sacosTrigo = parseInt(e.target.value) || 0; saveDraft();
  });
  document.getElementById("tickets").addEventListener("input", e => {
    state.tickets = parseInt(e.target.value) || 0; saveDraft();
  });

  // Observações
  document.getElementById("observacoes").addEventListener("input", e => {
    state.observacoes = e.target.value; saveDraft();
  });

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

  // Enviar
  document.getElementById("enviarBtn").addEventListener("click", enviarCierre);
}

function renderAll() {
  document.getElementById("fecha").value = state.fecha;
  document.getElementById("cajera").value = state.cajera;
  document.getElementById("sacosTrigo").value = state.sacosTrigo;
  document.getElementById("tickets").value = state.tickets;
  document.getElementById("observacoes").value = state.observacoes;
  renderIngresos();
  renderGastos();
  updateTotals();
}

// ============================================================================
// Enviar al Supabase
// ============================================================================
async function enviarCierre() {
  const btn = document.getElementById("enviarBtn");
  btn.disabled = true;
  btn.textContent = "⏳ Enviando...";
  const dot = document.getElementById("statusDot");
  dot.className = "inline-block w-2 h-2 rounded-full syncing-dot";

  try {
    // Map preset ingresos a columnas de dia_cierre
    const getPreset = (nombre) => state.ingresos.find(i => i.nombre === nombre && i.preset)?.monto || 0;
    const cierrePayload = {
      fecha: state.fecha,
      cajera: state.cajera,
      pix_rs: getPreset('PIX'),
      dinheiro_rs: getPreset('Dinheiro'),
      debito_rs: getPreset('Débito POS'),
      pago_movil_bs: getPreset('Pago Móvil'),
      bs_efectivo_bs: getPreset('Bs efectivo'),
      sacos_trigo: state.sacosTrigo,
      tickets: state.tickets,
      observacoes: state.observacoes,
      device: DEVICE_NAME,
    };

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

    toast("✅ Cierre enviado correctamente");
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
  bindStatic();

  // Intentar cargar borrador local primero
  const draft = await loadDraft(state.fecha);
  if (draft) {
    Object.assign(state, draft);
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

  renderAll();
})();

// Registrar Service Worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW fail:", err));
}
