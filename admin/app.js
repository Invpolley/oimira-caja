// OiMira Admin — lógica del panel
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { cargarTasaVigente, montarCambioTasa } from "./tasa-central.js";

/* ===== LECTURA CON COPIA (2026-09-24) — regla del ecosistema: sin internet todo sigue funcionando =====
   Cada lectura (GET a /rest/v1/, y las RPC de solo lectura indicadas) que llega bien se guarda en Cache Storage.
   Sin señal (o servidor 5xx) se devuelve la última copia y aparece una franja amarilla con la fecha.
   El nombre de la caché NO empieza con el prefijo de ningún service worker del sitio (GitHub Pages comparte origen). */
function crearFetchConCopia(CACHE_DATOS, rpcLectura) {
  rpcLectura = rpcLectura || [];
  var desde = 0;
  function pintar() {
    var b = document.getElementById("copiaBanner");
    if (!b) { b = document.createElement("div"); b.id = "copiaBanner"; b.style.cssText = "position:sticky;top:0;z-index:9999;background:#fef3c7;color:#92400e;font-size:12.5px;padding:6px 12px;text-align:center;border-bottom:1px solid #fcd34d;display:none"; document.body.prepend(b); }
    if (!desde) { b.style.display = "none"; return; }
    var d = new Date(desde);
    b.textContent = "📴 Sin señal · estás viendo lo guardado en este equipo (" + d.toLocaleDateString("es-VE", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" }) + ") — se actualiza solo al volver el internet. Para guardar cambios hace falta señal.";
    b.style.display = "block";
  }
  window.addEventListener("online", function () { desde = 0; pintar(); });
  return async function (input, init) {
    init = init || {};
    var url = typeof input === "string" ? input : input.url;
    var m = (init.method || (input && input.method) || "GET").toUpperCase();
    var esRpcLectura = m === "POST" && rpcLectura.some(function (n) { return url.indexOf("/rest/v1/rpc/" + n) >= 0; });
    var esLectura = ((m === "GET" || m === "HEAD") && url.indexOf("/rest/v1/") >= 0) || esRpcLectura;
    if (!esLectura || !("caches" in window)) return fetch(input, init);
    var clave = url + (url.indexOf("?") >= 0 ? "&" : "?") + "__m=" + m + (esRpcLectura ? "&__b=" + encodeURIComponent(String(init.body || "")) : "");
    async function copia(motivo) {
      try {
        var hit = await (await caches.open(CACHE_DATOS)).match(clave);
        if (hit) { var t = Number(hit.headers.get("x-guardado") || Date.now()); desde = desde ? Math.min(desde, t) : t; pintar(); return hit; }
      } catch (e) { /* */ }
      if (motivo instanceof Response) return motivo;
      throw motivo;
    }
    var r;
    try {
      if (!navigator.onLine) throw new TypeError("Failed to fetch (sin señal)");
      var ctl = new AbortController(); var tope = setTimeout(function () { ctl.abort(); }, 12000);
      try { r = await fetch(input, Object.assign({}, init, { signal: init.signal || ctl.signal })); } finally { clearTimeout(tope); }
    } catch (e) { return copia(e); }
    if (r.status >= 500) return copia(r);
    if (r.ok) {
      try {
        var h = new Headers(r.headers); h.set("x-guardado", String(Date.now()));
        var cp = new Response(await r.clone().arrayBuffer(), { status: r.status, statusText: r.statusText, headers: h });
        caches.open(CACHE_DATOS).then(function (c) { return c.put(clave, cp); }).catch(function () {});
      } catch (e) { /* sin espacio: seguir sin copia */ }
      if (desde) { desde = 0; pintar(); }
    }
    return r;
  };
}
const FETCH_COPIA_BASE = crearFetchConCopia("datos-caja-admin-v1");
// 2026-09-29 (seguridad): cada consulta lleva el token de la sesión del admin; la base de datos lo exige (RLS)
const FETCH_COPIA = (input, init = {}) => {
  const h = new Headers(init.headers || (input && input.headers) || {});
  const t = localStorage.getItem("oimira_admin_token"); if (t) h.set("x-caja-token", t);
  return FETCH_COPIA_BASE(input, { ...init, headers: h });
};
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { db: { schema: "oimira_caja" }, global: { fetch: FETCH_COPIA } });
const sbPagos = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: FETCH_COPIA } }); // schema public — app OiMira Pagos

// ============================================================
// Estado
// ============================================================
const state = {
  cierres: [],      // array de dia_cierre con joins
  cajaSaldos: [],   // array de caja_saldo_resumen
  cajaRetiros: [],  // array de caja_retiro
  rango: { desde: null, hasta: null },
  chartMode: "ingresos",
  expanded: new Set(),
  allExpanded: false,
  chart: null,
  cajaCharts: {},      // { efectivo, punto, puntoBr, usd }
  evolMetric: "total", // "total" o "hoy"
  sacoProductos: [],   // catálogo de sacos (tipo + peso = un producto)
  canales: [],         // catálogo de canales de saldo (etiqueta/visibilidad)
  sacoCompras: [],     // compras/recepciones de sacos
  sacoConsumo: [],     // consumo histórico (vista saco_consumo_diario)
  formasPago: [],      // catálogo de formas de pago de la caja
};

// Map clave de canal -> ids de su tarjeta en el HTML
const CANAL_CARD_IDS = {
  Efectivo: { card: "cardCanalEfectivo", lbl: "lblCanalEfectivo" },
  Punto:    { card: "cardCanalPunto",    lbl: "lblCanalPunto" },
  PuntoBr:  { card: "cardCanalPuntoBr",  lbl: "lblCanalPuntoBr" },
  USD:      { card: "cardCanalUSD",      lbl: "lblCanalUSD" },
  BCU:      { card: "cardCanalBCU",      lbl: "lblCanalBCU" },
};
// Fallback de canales si Supabase no responde (la UI nunca queda vacía)
const CANALES_FALLBACK = [
  { key: "Efectivo", label: "Efectivo R$", moeda: "R$",  icon: "💵", orden: 1, activo: true },
  { key: "Punto",    label: "Punto Bs",    moeda: "Bs",  icon: "📲", orden: 2, activo: true },
  { key: "PuntoBr",  label: "Punto Br R$", moeda: "R$",  icon: "💳", orden: 3, activo: true },
  { key: "USD",      label: "USD",         moeda: "USD", icon: "💵", orden: 4, activo: true },
  { key: "BCU",      label: "BCU",         moeda: "Bs",  icon: "🏦", orden: 5, activo: true },
];
// Saldo de la cuenta Banesco (Pago Móvil + POS juntos)
function bancoBs(r) { return Number((r && r.pago_movil_saldo_total) || 0) + Number((r && r.banesco_pos_saldo_total) || 0); }
function canalDef(key) {
  return (state.canales || []).find(c => c.key === key)
      || CANALES_FALLBACK.find(c => c.key === key)
      || { key, label: key, icon: "💰", activo: true };
}

// ============================================================
// Utilidades
// ============================================================
const $ = (id) => document.getElementById(id);
const fmtR = (n) => "R$ " + (Number(n) || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtB = (n) => "Bs " + (Number(n) || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtU = (n) => "US$ " + (Number(n) || 0).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtN = (n) => (Number(n) || 0).toLocaleString("es-AR");
const fmtMoeda = (n, m) => m === "Bs" ? fmtB(n) : m === "USD" ? fmtU(n) : fmtR(n);
// Huso horario de NEGOCIO fijo. La caja opera en Venezuela (UTC-4).
// CRÍTICO: no usar getFullYear/getDate del device ni toISOString() (UTC).
// Si el celular/PC está en otro huso (UTC, Brasil, automático), después de
// las 20:00 hora local el día saltaba al siguiente y descuadraba la caja.
// Anclando a America/Caracas la fecha es siempre la del negocio.
const APP_TZ = "America/Caracas";
function fechaEnCaracas(dateLike) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(dateLike); // => "YYYY-MM-DD"
}
function todayISO() {
  return fechaEnCaracas(new Date());
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return fechaEnCaracas(d);
}

function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function setStatus(kind, text) {
  const dot = $("statusDot");
  dot.className = "inline-block w-2 h-2 rounded-full " + (kind === "online" ? "online-dot" : kind === "offline" ? "offline-dot" : "syncing-dot");
  $("statusText").textContent = text;
}

// Formatea fecha YYYY-MM-DD como "sab 18 abr"
function fmtFecha(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "short" }).replace(".", "");
}

// ============================================================
// PIN gate
// ============================================================
function checkPinSession() {
  const until = Number(localStorage.getItem("oimira_admin_pin_until") || "0");
  // 26/09/2026: las sesiones abiertas con el viejo PIN general (sin nombre) ya no valen
  if (!localStorage.getItem("oimira_admin_quien")) { localStorage.removeItem("oimira_admin_pin_until"); return false; }
  // 29/09/2026: con señal hace falta el token de sesión (la base de datos ya no deja leer sin él)
  if (navigator.onLine && !localStorage.getItem("oimira_admin_token")) { localStorage.removeItem("oimira_admin_pin_until"); return false; }
  return Date.now() < until;
}
// Sin señal: entra quien ya entró con su PIN en ESTE equipo (últimos 30 días). Se guarda solo una huella SHA-256 con sal.
const OFF_KEY = "oimira_admin_offline_v1";
async function huella(pin, sal) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sal + ":" + pin));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function offlineGuardar(pin, nombre) {
  try {
    const sal = crypto.getRandomValues(new Uint32Array(4)).join("-");
    const lista = JSON.parse(localStorage.getItem(OFF_KEY) || "[]").filter((x) => x.nombre !== nombre && x.hasta > Date.now());
    lista.push({ nombre, sal, h: await huella(pin, sal), hasta: Date.now() + 30 * 86400000 });
    localStorage.setItem(OFF_KEY, JSON.stringify(lista));
  } catch (e) { /* sin crypto.subtle: solo con señal */ }
}
async function offlineVerificar(pin) {
  try {
    for (const x of JSON.parse(localStorage.getItem(OFF_KEY) || "[]")) if (x.hasta > Date.now() && (await huella(pin, x.sal)) === x.h) return x.nombre;
  } catch (e) { /* */ }
  return null;
}

function unlockUI() {
  $("pinGate").classList.add("hidden");
  $("app").classList.remove("hidden");
  const quien = localStorage.getItem("oimira_admin_quien");
  const lb = $("logoutBtn");
  if (lb) { lb.title = quien ? "Entró: " + quien : "Entró con el PIN general"; if (quien && !$("adminQuien")) lb.insertAdjacentHTML("beforebegin", '<span id="adminQuien" class="text-xs opacity-90 mr-1">👤 ' + quien.split(" ")[0].replace(/[<>&]/g, "") + '</span>'); }
  // 29/09/2026: si la sesión del servidor venció o le quitaron el permiso, volver a pedir el PIN
  const tk = localStorage.getItem("oimira_admin_token");
  if (tk && navigator.onLine) sbPagos.rpc("caja_sesion_ok", { p_token: tk, p_admin: true }).then(({ data, error }) => {
    if (!error && data === false) { ["oimira_admin_token", "oimira_admin_pin_until", "oimira_admin_quien"].forEach((k) => localStorage.removeItem(k)); location.reload(); }
  }).catch(() => {});
  try { mostrarBotonIngresar(); } catch (e) { /* */ }
  init();
}

function setupPinGate() {
  if (checkPinSession()) {
    unlockUI();
    return;
  }
  const input = $("pinInput");
  input.focus();
  // 2026-09-26 (pedido de Polley): SIN PIN general. Entra con su PIN PERSONAL de Compras quien tenga el
  // permiso "Admin de cierres de caja" (o sea dueño). Se administra en config.fitmassa.com → 👥 Accesos.
  // El PIN personal se verifica en el servidor (RPC caja_admin_login, queda registrado); sin señal entra quien ya entró en este equipo.
  const entrar = (quien) => {
    localStorage.setItem("oimira_admin_pin_until", String(Date.now() + 12 * 3600 * 1000)); // sesión 12h
    localStorage.setItem("oimira_admin_quien", quien || "Admin");
    unlockUI();
  };
  const fallo = (txt) => {
    $("pinError").textContent = txt || "PIN incorrecto";
    $("pinError").classList.remove("hidden");
    input.value = "";
    input.focus();
  };
  let verificando = false;
  const submit = async () => {
    const pin = input.value.trim();
    if (!pin) return;
    if (!/^[0-9]{4,10}$/.test(pin)) return fallo();
    if (verificando) return;
    if (!navigator.onLine) {
      const n = await offlineVerificar(pin);
      return n ? entrar(n) : fallo("Sin señal: solo puede entrar quien ya entró antes con su PIN en este equipo.");
    }
    verificando = true; $("pinSubmit").disabled = true; $("pinSubmit").textContent = "Verificando…";
    try {
      const { data, error } = await sbPagos.rpc("caja_admin_login", { p_pin: pin });
      if (error) throw error;
      if (data && data.ok) {
        // 2026-09-29: token de sesión para leer/abonar en OiMira Pagos (las tablas de Pagos ya no se leen directo)
        if (data.token) localStorage.setItem("oimira_admin_token", data.token);
        await offlineGuardar(pin, data.nombre || "Admin"); return entrar(data.nombre || "Admin");
      }
      fallo("PIN incorrecto o sin permiso para el admin de cierres");
    } catch (e) {
      if (/fetch|network|load failed|timeout/i.test(String(e && (e.message || e)))) {
        const n = await offlineVerificar(pin);
        return n ? entrar(n) : fallo("Sin señal: solo puede entrar quien ya entró antes con su PIN en este equipo.");
      }
      fallo("No se pudo verificar: " + (e.message || e));
    } finally {
      verificando = false; $("pinSubmit").disabled = false; $("pinSubmit").textContent = "Entrar";
    }
  };
  $("pinSubmit").addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

// ============================================================
// Fetch Supabase
// ============================================================
async function fetchCierres(desde, hasta) {
  setStatus("syncing", "Cargando...");
  const { data, error } = await sb
    .from("dia_cierre")
    .select("*,forma_pago_extra(*),dia_gasto(*),dia_saco(*)")
    .gte("fecha", desde)
    .lte("fecha", hasta)
    .order("fecha", { ascending: false });
  if (error) {
    setStatus("offline", "Error");
    toast("Error: " + error.message, 4000);
    throw error;
  }
  setStatus("online", "Conectado");
  return data || [];
}

// ============================================================
// Cálculos por cierre
// ============================================================
// Tasas default (solo aplican si un cierre legacy no tiene tasas guardadas)
const TASA_BS_DEFAULT_ADMIN  = 0.017;
const TASA_USD_DEFAULT_ADMIN = 5.10;

function calcCierre(c) {
  const extraR = (c.forma_pago_extra || []).filter(fp => fp.moeda === "R$").reduce((s, fp) => s + Number(fp.monto || 0), 0);
  const extraB = (c.forma_pago_extra || []).filter(fp => fp.moeda === "Bs").reduce((s, fp) => s + Number(fp.monto || 0), 0);
  const extraU = (c.forma_pago_extra || []).filter(fp => fp.moeda === "USD").reduce((s, fp) => s + Number(fp.monto || 0), 0);
  const gastoR = (c.dia_gasto || []).filter(g => g.moeda === "R$").reduce((s, g) => s + Number(g.monto || 0), 0);
  const gastoB = (c.dia_gasto || []).filter(g => g.moeda === "Bs").reduce((s, g) => s + Number(g.monto || 0), 0);
  const gastoU = (c.dia_gasto || []).filter(g => g.moeda === "USD").reduce((s, g) => s + Number(g.monto || 0), 0);

  // Venta efectivo R$ bruta (nueva columna).
  // Legacy fallback: si ventas_efectivo_rs es null o 0, usar dinheiro_rs como aproximación
  // (la app vieja guardaba el monto ingresado por la cajera en dinheiro_rs).
  const _ve = Number(c.ventas_efectivo_rs || 0);
  const ventaEfectivoBruta = _ve > 0 ? _ve : Number(c.dinheiro_rs || 0);
  const isLegacyBruto = _ve === 0 && Number(c.dinheiro_rs || 0) > 0;

  const ingR = Number(c.pix_rs || 0) + ventaEfectivoBruta + Number(c.debito_rs || 0) + extraR;
  const ingB = Number(c.pago_movil_bs || 0) + Number(c.bs_efectivo_bs || 0) + extraB;
  const ingU = Number(c.usd_usd || 0) + extraU;

  // Tasas históricas del registro (inmutables). Legacy → defaults
  const tasaBs  = c.tasa_bs_rs  != null ? Number(c.tasa_bs_rs)  : TASA_BS_DEFAULT_ADMIN;
  const tasaUsd = c.tasa_usd_rs != null ? Number(c.tasa_usd_rs) : TASA_USD_DEFAULT_ADMIN;

  // Gran Total Venta consolidado en R$ con las tasas de ESE día
  const granTotalRs = ingR + (ingB * tasaBs) + (ingU * tasaUsd);
  const gastosTotalRs = gastoR + (gastoB * tasaBs) + (gastoU * tasaUsd);
  const netoConsolidadoRs = granTotalRs - gastosTotalRs;

  // Efectivo que queda físico R$ (para arqueo)
  const efectivoQuedaRs = ventaEfectivoBruta - gastoR;

  return {
    ingR, ingB, ingU, gastoR, gastoB, gastoU,
    netoR: ingR - gastoR,
    netoB: ingB - gastoB,
    netoU: ingU - gastoU,
    extraR, extraB, extraU,
    // Nuevos con tasas históricas
    ventaEfectivoBruta,
    tasaBs, tasaUsd,
    granTotalRs,
    gastosTotalRs,
    netoConsolidadoRs,
    efectivoQuedaRs,
    legacyRates: c.tasa_bs_rs == null || c.tasa_usd_rs == null,
  };
}

// ============================================================
// Render KPIs
// ============================================================
function renderKPIs() {
  let totR = 0, totB = 0, totU = 0, totGasR = 0, totGasB = 0, totGasU = 0;
  let totGranTotalRs = 0, totNetoConsolidadoRs = 0;
  for (const c of state.cierres) {
    const k = calcCierre(c);
    totR += k.ingR; totB += k.ingB; totU += k.ingU;
    totGasR += k.gastoR; totGasB += k.gastoB; totGasU += k.gastoU;
    totGranTotalRs += k.granTotalRs;
    totNetoConsolidadoRs += k.netoConsolidadoRs;
  }
  $("kpiIngRs").textContent = fmtR(totR);
  $("kpiIngBs").textContent = fmtB(totB);
  $("kpiIngUsd").textContent = fmtU(totU);
  $("kpiGastos").textContent = fmtR(totGasR) + " / " + fmtB(totGasB) + (totGasU > 0 ? " / " + fmtU(totGasU) : "");
  $("kpiDias").textContent = state.cierres.length;
  const d1 = state.rango.desde, d2 = state.rango.hasta;
  $("kpiDiasRango").textContent = `(${fmtFecha(d1)} → ${fmtFecha(d2)})`;

  // Nuevos KPIs consolidados
  const kgt = $("kpiGranTotal");
  const kns = $("kpiNetoCons");
  if (kgt) kgt.textContent = fmtR(totGranTotalRs);
  if (kns) {
    kns.textContent = fmtR(totNetoConsolidadoRs);
    kns.className = "kpi-value mono " + (totNetoConsolidadoRs < 0 ? "text-red-700" : "text-amber-800");
  }
}

// ============================================================
// Render gráfico
// ============================================================
function renderChart() {
  const ctx = $("chartEvolucion").getContext("2d");
  const ordenados = [...state.cierres].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const labels = ordenados.map(c => fmtFecha(c.fecha));
  let datasets = [];

  if (state.chartMode === "ingresos") {
    datasets = [
      {
        label: "Ingresos R$",
        data: ordenados.map(c => calcCierre(c).ingR),
        backgroundColor: "rgba(22, 163, 74, 0.6)",
        borderColor: "#16a34a",
        borderWidth: 2,
      },
      {
        label: "Ingresos Bs",
        data: ordenados.map(c => calcCierre(c).ingB),
        backgroundColor: "rgba(59, 130, 246, 0.6)",
        borderColor: "#3b82f6",
        borderWidth: 2,
        yAxisID: "y1",
      },
    ];
  } else if (state.chartMode === "neto") {
    datasets = [
      {
        label: "Neto R$",
        data: ordenados.map(c => calcCierre(c).netoR),
        backgroundColor: "rgba(217, 119, 6, 0.6)",
        borderColor: "#d97706",
        borderWidth: 2,
      },
      {
        label: "Neto Bs",
        data: ordenados.map(c => calcCierre(c).netoB),
        backgroundColor: "rgba(147, 51, 234, 0.6)",
        borderColor: "#9333ea",
        borderWidth: 2,
        yAxisID: "y1",
      },
    ];
  } else if (state.chartMode === "trigo") {
    datasets = [
      {
        label: "Sacos trigo",
        data: ordenados.map(c => Number(c.sacos_trigo || 0)),
        backgroundColor: "rgba(180, 83, 9, 0.6)",
        borderColor: "#b45309",
        borderWidth: 2,
      },
      {
        label: "Tickets",
        data: ordenados.map(c => Number(c.tickets || 0)),
        backgroundColor: "rgba(107, 114, 128, 0.5)",
        borderColor: "#6b7280",
        borderWidth: 2,
        yAxisID: "y1",
      },
    ];
  }

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: { beginAtZero: true, position: "left", title: { display: true, text: datasets[0]?.label || "" } },
        y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: datasets[1]?.label || "" } },
      },
      plugins: {
        legend: { position: "top" },
      },
    },
  });
}

// ============================================================
// Render lista de días
// ============================================================
// 🔎 Buscador de cierres (04/10/2026): fecha (15/09, 2026-09-15, "sab"), cajera, gastos, formas de pago, notas
function _sinAcentos(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
function cierreCoincide(c, q) {
  if (!q) return true;
  const [y, m, d] = String(c.fecha).split("-");
  const textos = [
    c.fecha, d + "/" + m, d + "/" + m + "/" + y, Number(d) + "/" + Number(m), fmtFecha(c.fecha),
    c.cajera, c.observacoes,
    ...(c.dia_gasto || []).map(g => (g.descripcion || "") + " " + (g.categoria || "") + " " + g.monto),
    ...(c.forma_pago_extra || []).map(f => f.nombre),
  ];
  const hay = _sinAcentos(textos.join(" | "));
  return _sinAcentos(q).split(/\s+/).filter(Boolean).every(p => hay.includes(p));
}
function renderDias() {
  const list = $("diasList");
  list.innerHTML = "";
  const q = ($("buscarCierre") && $("buscarCierre").value.trim()) || "";
  const visibles = state.cierres.filter(c => cierreCoincide(c, q));
  const info = $("buscarInfo");
  if (info) info.textContent = q
    ? (visibles.length + " de " + state.cierres.length + " cierres del período coinciden. Si no está, cambia las fechas arriba o usa 📆 Otro día.")
    : (state.cierres.length + " cierres del " + fmtFecha(state.rango.desde) + " al " + fmtFecha(state.rango.hasta) + ".");
  $("emptyState").classList.toggle("hidden", visibles.length > 0);
  $("loadingState").classList.add("hidden");

  for (const c of visibles) {
    const k = calcCierre(c);
    const isExp = state.expanded.has(c.id);

    // Fila principal
    const row = document.createElement("div");
    row.className = "day-row" + (isExp ? " expanded" : "");
    row.innerHTML = `
      <div class="font-semibold text-sm text-amber-900">${fmtFecha(c.fecha)}</div>
      <div class="text-right mono font-bold text-green-700 text-sm">${fmtR(k.ingR)}</div>
      <div class="text-right mono font-bold text-blue-700 text-sm col-bs">${fmtB(k.ingB)}</div>
      <div class="text-center text-xs text-gray-600 col-cajera">🌾${c.sacos_trigo || 0}</div>
      <div class="text-right text-gray-400">${isExp ? "▼" : "▶"}</div>
    `;
    row.addEventListener("click", () => {
      if (state.expanded.has(c.id)) state.expanded.delete(c.id);
      else state.expanded.add(c.id);
      renderDias();
    });
    list.appendChild(row);

    // Panel de detalle
    if (isExp) {
      const detail = document.createElement("div");
      detail.className = "detail-panel";

      // Formas de pago (breakdown)
      const formasHtml = [];
      if (Number(c.pix_rs) > 0) formasHtml.push(`<span class="pill pill-r">PIX ${fmtR(c.pix_rs)}</span>`);
      if (Number(c.dinheiro_rs) > 0) formasHtml.push(`<span class="pill pill-r">Efectivo ${fmtR(c.dinheiro_rs)}</span>`);
      if (Number(c.efectivo_deteriorado_rs) > 0) formasHtml.push(`<span class="pill pill-r">🩹 Deteriorado ${fmtR(c.efectivo_deteriorado_rs)}</span>`);
      if (Number(c.debito_rs) > 0) formasHtml.push(`<span class="pill pill-r">Débito ${fmtR(c.debito_rs)}</span>`);
      if (Number(c.pago_movil_bs) > 0) formasHtml.push(`<span class="pill pill-b">Pago Móvil ${fmtB(c.pago_movil_bs)}</span>`);
      if (Number(c.bs_efectivo_bs) > 0) formasHtml.push(`<span class="pill pill-b">Bs efectivo ${fmtB(c.bs_efectivo_bs)}</span>`);
      if (Number(c.usd_usd) > 0) formasHtml.push(`<span class="pill" style="background:#d1fae5;color:#065f46">US$ ${fmtU(c.usd_usd)}</span>`);
      for (const fp of (c.forma_pago_extra || [])) {
        const cls = fp.moeda === "R$" ? "pill-r" : "pill-b";
        const fmt = fp.moeda === "R$" ? fmtR(fp.monto) : fmtB(fp.monto);
        formasHtml.push(`<span class="pill ${cls}">${escapeHtml(fp.nombre)} ${fmt}</span>`);
      }

      // Gastos list
      const gastosHtml = (c.dia_gasto || []).map(g => `
        <div class="flex justify-between items-center text-sm py-1 border-b border-red-100 last:border-0">
          <div>
            <span class="font-semibold text-red-900">${escapeHtml(g.descripcion || "(sin descripción)")}</span>
            ${g.categoria ? `<span class="pill pill-gas ml-2">${escapeHtml(g.categoria)}</span>` : ""}
          </div>
          <div class="mono font-bold text-red-700">${g.moeda === "R$" ? fmtR(g.monto) : fmtB(g.monto)}</div>
        </div>
      `).join("") || `<div class="text-xs text-gray-500 italic">Sin gastos registrados</div>`;

      detail.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <div class="text-xs font-bold text-gray-600 uppercase mb-2">Ingresos · ${fmtR(k.ingR)} / ${fmtB(k.ingB)}</div>
            <div class="flex flex-wrap gap-1">${formasHtml.length ? formasHtml.join("") : '<span class="text-xs text-gray-500 italic">Sin ingresos</span>'}</div>
            <div class="mt-3 text-xs text-gray-600">
              🎫 Tickets: <b>${c.tickets || 0}</b> · 🌾 Sacos: <b>${c.sacos_trigo || 0}</b>
            </div>
            <div class="text-xs text-gray-600">
              👤 Cajera: <b>${escapeHtml(c.cajera || "—")}</b> · 📤 Enviado: ${c.transmitted_at ? new Date(c.transmitted_at).toLocaleString("es-AR") : "—"}
            </div>
          </div>
          <div>
            <div class="text-xs font-bold text-gray-600 uppercase mb-2">Gastos · ${fmtR(k.gastoR)} / ${fmtB(k.gastoB)}</div>
            <div class="bg-white rounded-lg p-2 border border-red-200">
              ${gastosHtml}
            </div>
          </div>
        </div>
        ${c.observacoes ? `
          <div class="mt-3 p-2 bg-white rounded-lg border border-gray-200">
            <div class="text-xs font-bold text-gray-600 uppercase mb-1">📝 Observaciones</div>
            <div class="text-sm text-gray-800 whitespace-pre-wrap">${escapeHtml(c.observacoes)}</div>
          </div>
        ` : ""}
        <div class="mt-3 pt-2 border-t border-amber-300 flex justify-between items-center text-sm">
          <div class="text-gray-600">Neto del día:</div>
          <div class="mono font-bold ${k.netoR >= 0 ? "text-green-700" : "text-red-700"}">${fmtR(k.netoR)}</div>
          <div class="mono font-bold ${k.netoB >= 0 ? "text-green-700" : "text-red-700"}">${fmtB(k.netoB)}</div>
        </div>
        <!-- Tasas + totales consolidados del día -->
        <div class="mt-3 p-2 bg-white border border-amber-300 rounded-lg text-xs space-y-1">
          <div class="font-bold text-amber-800 flex items-center justify-between">
            <span>💱 Tasas del día ${k.legacyRates ? '<span class="text-[10px] text-gray-500 italic">(default — cierre legacy)</span>' : ''}</span>
            <span class="mono text-amber-700">1 Bs = ${k.tasaBs.toFixed(4)} R$ · 1 USD = ${k.tasaUsd.toFixed(4)} R$</span>
          </div>
          <div class="flex justify-between pt-1 border-t border-gray-200">
            <span>🏆 Gran Total Venta (R$ equiv):</span>
            <span class="mono font-bold text-green-700">${fmtR(k.granTotalRs)}</span>
          </div>
          <div class="flex justify-between">
            <span>💸 Gastos total (R$ equiv):</span>
            <span class="mono font-semibold text-red-700">−${fmtR(k.gastosTotalRs)}</span>
          </div>
          <div class="flex justify-between">
            <span>💵 Efectivo que queda (físico R$):</span>
            <span class="mono font-semibold ${k.efectivoQuedaRs < 0 ? 'text-red-700' : 'text-amber-800'}">${fmtR(k.efectivoQuedaRs)}</span>
          </div>
          <div class="flex justify-between pt-1 border-t border-amber-300">
            <span class="font-bold">📈 Neto consolidado R$:</span>
            <span class="mono font-bold text-lg ${k.netoConsolidadoRs < 0 ? 'text-red-700' : 'text-green-700'}">${fmtR(k.netoConsolidadoRs)}</span>
          </div>
        </div>
      `;
      list.appendChild(detail);
    }
  }
}

// ============================================================
// Resumen por cajera
// ============================================================
function renderPorCajera() {
  const cont = $("porCajera");
  const map = new Map();
  for (const c of state.cierres) {
    const k = calcCierre(c);
    const key = c.cajera || "—";
    if (!map.has(key)) map.set(key, { ingR: 0, ingB: 0, dias: 0 });
    const m = map.get(key);
    m.ingR += k.ingR;
    m.ingB += k.ingB;
    m.dias += 1;
  }
  const rows = [...map.entries()].sort((a, b) => b[1].ingR + b[1].ingB - (a[1].ingR + a[1].ingB));
  cont.innerHTML = rows.length ? rows.map(([nombre, m]) => `
    <div class="flex items-center justify-between p-2 bg-amber-50 border border-amber-200 rounded-lg">
      <div class="font-semibold text-amber-900">👤 ${escapeHtml(nombre)}</div>
      <div class="text-right text-sm">
        <div class="mono font-bold text-green-700">${fmtR(m.ingR)} <span class="text-gray-400">/</span> <span class="text-blue-700">${fmtB(m.ingB)}</span></div>
        <div class="text-xs text-gray-600">${m.dias} día${m.dias === 1 ? "" : "s"}</div>
      </div>
    </div>
  `).join("") : `<div class="text-xs text-gray-500 italic">Sin datos</div>`;
}

// ============================================================
// Resumen por categoría de gasto
// ============================================================
function renderPorCategoria() {
  const cont = $("porCategoria");
  const map = new Map();
  for (const c of state.cierres) {
    for (const g of (c.dia_gasto || [])) {
      const key = (g.categoria || "Sin categoría") + "|" + g.moeda;
      if (!map.has(key)) map.set(key, { cat: g.categoria || "Sin categoría", moeda: g.moeda, total: 0, count: 0 });
      const m = map.get(key);
      m.total += Number(g.monto || 0);
      m.count += 1;
    }
  }
  const rows = [...map.values()].sort((a, b) => b.total - a.total);
  cont.innerHTML = rows.length ? rows.map(r => `
    <div class="flex items-center justify-between p-2 bg-red-50 border border-red-200 rounded-lg">
      <div>
        <span class="font-semibold text-red-900">${escapeHtml(r.cat)}</span>
        <span class="text-xs text-gray-500 ml-2">${r.count} mov.</span>
      </div>
      <div class="mono font-bold text-red-700">${r.moeda === "R$" ? fmtR(r.total) : fmtB(r.total)}</div>
    </div>
  `).join("") : `<div class="text-xs text-gray-500 italic">Sin gastos en este rango</div>`;
}

// ============================================================
// Export CSV
// ============================================================
function exportCSV() {
  const header = [
    "fecha", "cajera",
    "pix_rs", "dinheiro_rs", "debito_rs", "extras_rs",
    "pago_movil_bs", "bs_efectivo_bs", "extras_bs",
    "usd_usd", "extras_usd",
    "total_ing_rs", "total_ing_bs", "total_ing_usd",
    "gastos_rs", "gastos_bs", "gastos_usd",
    "neto_rs", "neto_bs", "neto_usd",
    "tickets", "sacos_trigo",
    "observacoes",
  ];
  const rows = [header.join(",")];
  const ordenados = [...state.cierres].sort((a, b) => a.fecha.localeCompare(b.fecha));
  for (const c of ordenados) {
    const k = calcCierre(c);
    const row = [
      c.fecha,
      csvEsc(c.cajera || ""),
      c.pix_rs || 0, c.dinheiro_rs || 0, c.debito_rs || 0, k.extraR.toFixed(2),
      c.pago_movil_bs || 0, c.bs_efectivo_bs || 0, k.extraB.toFixed(2),
      c.usd_usd || 0, k.extraU.toFixed(2),
      k.ingR.toFixed(2), k.ingB.toFixed(2), k.ingU.toFixed(2),
      k.gastoR.toFixed(2), k.gastoB.toFixed(2), k.gastoU.toFixed(2),
      k.netoR.toFixed(2), k.netoB.toFixed(2), k.netoU.toFixed(2),
      c.tickets || 0, c.sacos_trigo || 0,
      csvEsc(c.observacoes || ""),
    ];
    rows.push(row.join(","));
  }
  const csv = rows.join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `oimira-cierres-${state.rango.desde}_${state.rango.hasta}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast("CSV descargado");
}

function csvEsc(v) {
  v = String(v);
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================
// Controllers
// ============================================================
async function reload({ preserveExpanded = true } = {}) {
  $("loadingState").classList.remove("hidden");
  $("diasList").innerHTML = "";
  $("emptyState").classList.add("hidden");
  try {
    const [cierres, cajaSaldos, cajaRetiros] = await Promise.all([
      fetchCierres(state.rango.desde, state.rango.hasta),
      fetchCajaSaldos(state.rango.desde, state.rango.hasta),
      fetchCajaRetiros(state.rango.desde, state.rango.hasta),
      fetchSacoCatalogos(),
      fetchCanales(),
      fetchSacoCompras(),
      fetchSacoConsumo(),
      fetchFormasPago(),
      fetchCajeras(),
    ]);
    state.cierres = cierres;
    state.cajaSaldos = cajaSaldos;
    state.cajaRetiros = cajaRetiros;
    if (!preserveExpanded) {
      state.expanded.clear();
      state.allExpanded = false;
      $("toggleAllBtn").textContent = "Expandir todo";
    }
    renderKPIs();
    renderChart();
    renderDias();
    renderPorCajera();
    renderPorCategoria();
    renderSacosReporte();
    renderSacosInventario();
    renderSacosAnalitica();
    renderSacosAdmin();
    renderCanalesAdmin();
    renderDeteriorado();
    renderFormasPagoAdmin();
    renderCajerasAdmin();
    renderCajaSaldos();
    renderCajaRetiros();
    renderCajaEvolucion();
    renderAlertaStock();
    updateLastRefreshLabel();
  } catch (e) {
    console.error(e);
  }
  // El resumen tiene sus propias fechas (ayer, 7 días, mes): se recalcula aparte y nunca frena lo demás
  cargarResumen().catch(e => console.error("resumen", e));
}

function updateLastRefreshLabel() {
  const el = $("lastRefreshLabel");
  if (!el) return;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  el.textContent = "Actualizado " + hh + ":" + mm;
}

function setRango(desde, hasta) {
  state.rango.desde = desde;
  state.rango.hasta = hasta;
  $("fechaDesde").value = desde;
  $("fechaHasta").value = hasta;
  // Cambio de rango: tiene sentido colapsar los detalles (son otros días)
  reload({ preserveExpanded: false });
}

// ============================================================
// ============================================================
// 🌾 Sacos de trigo: reporte de consumo + gestión de catálogo
// ============================================================
async function fetchSacoCatalogos() {
  // Se lee de la vista saco_stock_actual: trae los mismos campos del catálogo
  // MÁS el stock ya calculado en la base de datos sobre el historial completo.
  // Las escrituras siguen yendo a saco_producto por id (la vista expone id).
  const { data, error } = await sb.from("saco_stock_actual").select("*").order("orden");
  if (error) {
    const r = await sb.from("saco_producto").select("*").order("orden");
    state.sacoProductos = r.data || [];
    return;
  }
  state.sacoProductos = data || [];
}

function renderSacosReporte() {
  const cont = $("sacosReporte");
  if (!cont) return;
  let totalSacos = 0, totalKg = 0;
  const porTipo = {};
  state.cierres.forEach(c => {
    (c.dia_saco || []).forEach(s => {
      const cant = parseInt(s.cantidad) || 0;
      const kg = Number(s.kg) || 0;
      if (cant <= 0) return;
      totalSacos += cant;
      totalKg += cant * kg;
      porTipo[s.tipo] = porTipo[s.tipo] || { sacos: 0, kg: 0 };
      porTipo[s.tipo].sacos += cant;
      porTipo[s.tipo].kg += cant * kg;
    });
  });

  if (totalSacos === 0) {
    cont.innerHTML = `<div class="text-xs text-gray-400">Sin sacos registrados en el rango.</div>`;
    return;
  }

  const colorDe = (t) => (state.sacoProductos.find(x => x.nombre === t)?.color) || "#9ca3af";
  const filas = Object.entries(porTipo)
    .sort((a, b) => b[1].kg - a[1].kg)
    .map(([tipo, v]) => `
      <div class="flex items-center justify-between">
        <span class="flex items-center gap-2">
          <span class="inline-block w-3 h-3 rounded-full" style="background:${colorDe(tipo)}"></span>
          ${escapeHtml(tipo)}
        </span>
        <span class="mono text-gray-700">${fmtN(v.sacos)} sacos · ${fmtN(v.kg)} kg</span>
      </div>`).join("");

  cont.innerHTML = `
    <div class="flex items-center justify-between font-bold text-amber-900 border-b border-amber-200 pb-1 mb-1">
      <span>Total del rango</span>
      <span class="mono">${fmtN(totalSacos)} sacos · ${fmtN(totalKg)} kg</span>
    </div>
    ${filas}`;
}

function renderSacosAdmin() {
  const cont = $("sacoProductosAdmin");
  if (!cont) return;
  cont.innerHTML = (state.sacoProductos || []).map(p => {
    const label = p.label || `${p.nombre} ${p.kg}kg`;
    const activo = p.activo !== false;
    return `
      <div class="flex items-center gap-1 text-sm">
        <span class="inline-block w-3 h-3 rounded-full" style="background:${p.color || '#9ca3af'}"></span>
        <span class="flex-1 ${activo ? '' : 'line-through text-gray-400'}">${escapeHtml(label)}</span>
        <button type="button" data-id="${p.id}" data-activo="${activo}" class="saco-prod-toggle text-[11px] px-1.5 py-0.5 rounded ${activo ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}">${activo ? 'activo' : 'off'}</button>
        <button type="button" data-id="${p.id}" class="saco-prod-del text-rose-600 px-1">🗑</button>
      </div>`;
  }).join("") || `<div class="text-[11px] text-gray-400">Sin sacos. Agregá uno abajo.</div>`;
  wireSacosRowListeners();
}

// 2026-09-24: estos guardados no revisaban el error → sin señal decían "listo" sin haber guardado.
function errGuardar(e) {
  const m = String((e && (e.message || e)) || "");
  return (!navigator.onLine || /fetch|network|load failed/i.test(m)) ? "📵 Sin conexión: no se guardó. Inténtalo cuando vuelva la señal." : "No se guardó: " + m;
}
function wireSacosRowListeners() {
  document.querySelectorAll(".saco-prod-toggle").forEach(b => b.onclick = async () => {
    const { error } = await sb.from("saco_producto").update({ activo: !(b.dataset.activo === "true") }).eq("id", b.dataset.id);
    if (error) { toast(errGuardar(error), 4000); return; }
    await fetchSacoCatalogos(); renderSacosAdmin();
  });
  document.querySelectorAll(".saco-prod-del").forEach(b => b.onclick = async () => {
    if (!confirm("¿Archivar este saco del catálogo? Deja de verse en la caja; los cierres ya guardados conservan su dato y queda en 🕓 Historial.")) return;
    const { error } = await sb.from("saco_producto").delete().eq("id", b.dataset.id);
    if (error) {
      // La base de datos ahora protege el historial: un saco con consumo o compras
      // registradas no se puede borrar sin dejar esos registros huérfanos (fue lo
      // que pasó con "Azul 50kg"). Se ofrece ocultarlo en su lugar.
      if (error.code === "23503") {
        if (confirm("Este saco ya tiene consumo o compras registradas, así que no se puede borrar sin romper el historial.\n\n¿Querés ocultarlo? Deja de aparecer en la app pero los registros viejos se conservan.")) {
          const r2 = await sb.from("saco_producto").update({ activo: false }).eq("id", b.dataset.id);
          if (r2.error) { toast(errGuardar(r2.error), 4000); return; }
          await fetchSacoCatalogos(); renderSacosAdmin();
          toast("Saco ocultado");
        }
        return;
      }
      toast("No se pudo borrar: " + error.message, 4000);
      return;
    }
    await fetchSacoCatalogos(); renderSacosAdmin();
    toast("Saco archivado (queda en 🕓 Historial)");
  });
}

function wireSacosListeners() {
  const add = $("addSacoProdBtn");
  if (add) add.addEventListener("click", async () => {
    const nombre = ($("nuevoSacoNombre").value || "").trim();
    const kg = parseFloat($("nuevoSacoKg").value);
    const color = $("nuevoSacoColor").value || "#2563eb";
    if (!nombre) { toast("Poné el tipo (ej. Azul)"); return; }
    if (!kg || kg <= 0) { toast("Poné el peso en kg"); return; }
    const orden = (state.sacoProductos.length || 0) + 1;
    const label = `${nombre} ${kg}kg`;
    const { error } = await sb.from("saco_producto").insert({ nombre, kg, label, color, orden, activo: true });
    if (error) { toast(error.message.includes("duplicate") ? "Ese saco ya existe" : "Error: " + error.message, 4000); return; }
    $("nuevoSacoNombre").value = ""; $("nuevoSacoKg").value = "";
    await fetchSacoCatalogos(); renderSacosAdmin();
    toast("Saco agregado");
  });
}

// ============================================================
// 💰 Canales de saldo: renombrar / mostrar-ocultar (administrativo)
// ============================================================
async function fetchCanales() {
  const { data } = await sb.from("canal_caja").select("*").order("orden");
  state.canales = (data && data.length > 0) ? data : CANALES_FALLBACK.slice();
}

// Aplica etiquetas y visibilidad a las tarjetas de saldo del dashboard
function aplicarLabelsCanales() {
  Object.entries(CANAL_CARD_IDS).forEach(([key, ids]) => {
    const def = canalDef(key);
    const lbl = $(ids.lbl);
    if (lbl) lbl.textContent = `${def.icon || "💰"} ${def.label || key}`;
    const card = $(ids.card);
    if (card) card.style.display = (def.activo === false) ? "none" : "";
  });
}

function renderCanalesAdmin() {
  const cont = $("canalesAdmin");
  if (!cont) return;
  const fuente = (state.canales && state.canales.length > 0) ? state.canales : CANALES_FALLBACK;
  cont.innerHTML = fuente
    .slice()
    .sort((a, b) => (a.orden || 0) - (b.orden || 0))
    .map(c => `
      <div class="flex items-center gap-1 text-sm">
        <span>${c.icon || "💰"}</span>
        <input type="text" class="canal-label flex-1 p-1.5 border-2 border-gray-300 rounded text-sm"
               data-key="${escapeHtml(c.key)}" value="${escapeHtml(c.label)}" />
        <span class="text-[10px] text-gray-400 w-8 text-center">${escapeHtml(c.moeda || "")}</span>
        <button type="button" data-key="${escapeHtml(c.key)}" data-activo="${c.activo !== false}"
                class="canal-toggle text-[11px] px-1.5 py-0.5 rounded ${c.activo !== false ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}">
          ${c.activo !== false ? 'visible' : 'oculto'}
        </button>
        <button type="button" data-key="${escapeHtml(c.key)}" class="canal-save text-[11px] px-2 py-0.5 rounded bg-amber-600 text-white font-bold">💾</button>
      </div>`).join("");

  cont.querySelectorAll(".canal-save").forEach(b => b.onclick = async () => {
    const key = b.dataset.key;
    const inp = cont.querySelector(`.canal-label[data-key="${CSS.escape(key)}"]`);
    const nuevo = (inp.value || "").trim();
    if (!nuevo) { toast("El nombre no puede quedar vacío"); return; }
    const { error } = await sb.from("canal_caja").update({ label: nuevo }).eq("key", key);
    if (error) { toast("Error: " + error.message, 4000); return; }
    await fetchCanales(); aplicarLabelsCanales(); renderCanalesAdmin();
    toast("Nombre actualizado");
  });

  cont.querySelectorAll(".canal-toggle").forEach(b => b.onclick = async () => {
    const key = b.dataset.key;
    const nuevoActivo = !(b.dataset.activo === "true");
    if (!nuevoActivo && !confirm(`¿Ocultar "${canalLabel(key)}"?\n\nDeja de mostrarse en las tarjetas y en los retiros. Esto CAMBIA lo que ves en la información general (los totales mostrados). La data guardada NO se borra y podés volver a mostrarlo cuando quieras.`)) return;
    const { error } = await sb.from("canal_caja").update({ activo: nuevoActivo }).eq("key", key);
    if (error) { toast("Error: " + error.message, 4000); return; }
    await fetchCanales(); aplicarLabelsCanales(); renderCajaSaldos(); renderCanalesAdmin();
    toast(nuevoActivo ? "Canal visible" : "Canal oculto");
  });
}

// ============================================================
// Init + event listeners
// ============================================================
// ============================================================
// 🌾 Inventario, gráficos, pronóstico y costo de trigo
// ============================================================
async function fetchSacoCompras() {
  const { data } = await sb.from("saco_compra").select("*").order("fecha", { ascending: false });
  state.sacoCompras = data || [];
}
async function fetchSacoConsumo() {
  // 04/10/2026: TODO el histórico (antes solo 190 días). Son pocas filas (una por tipo de saco por día).
  const { data } = await sb.from("saco_consumo_diario").select("*").order("fecha");
  state.sacoConsumo = data || [];
}

function _stockActual(prod) {
  // El stock_base es el conteo físico a esa fecha (verdad absoluta, ya incluye lo de ese día).
  // Solo los movimientos POSTERIORES (fecha > stock_fecha) ajustan: compras suman, consumo resta.
  // Sin ajuste (stock_fecha null) => cuenta todo el historial desde el inicio.
  // El stock lo calcula ahora la base de datos (vista saco_stock_actual) sobre el
  // historial COMPLETO. Antes se sumaba acá con lo que el navegador tenía cargado,
  // y el consumo solo se pedía de los últimos 190 días mientras las compras se
  // pedían desde siempre: si el conteo físico quedaba viejo o sin fecha, el consumo
  // antiguo desaparecía del cálculo y el stock se mostraba INFLADO.
  if (prod.stock_actual != null) return Number(prod.stock_actual) || 0;

  // Respaldo (solo si la vista no respondió): cálculo local como antes.
  const F = prod.stock_fecha || "0000-01-01";
  const cons = (state.sacoConsumo || [])
    .filter(c => c.tipo === prod.nombre && Number(c.kg) === Number(prod.kg) && c.fecha > F)
    .reduce((s, c) => s + (parseInt(c.cantidad) || 0), 0);
  const comp = (state.sacoCompras || [])
    .filter(c => c.nombre === prod.nombre && Number(c.kg) === Number(prod.kg) && c.fecha > F)
    .reduce((s, c) => s + (parseInt(c.cantidad) || 0), 0);
  return (Number(prod.stock_base) || 0) - cons + comp;
}
// Precio/moneda actual = de la compra más reciente con precio cargado
function _ultimaCompra(prod) {
  const cs = (state.sacoCompras || [])
    .filter(c => c.nombre === prod.nombre && Number(c.kg) === Number(prod.kg) && c.precio_unit != null)
    .sort((a, b) => (a.fecha < b.fecha ? 1 : (a.fecha > b.fecha ? -1 : 0)));
  return cs.length ? cs[0] : null;
}
function _precioActual(prod) { const c = _ultimaCompra(prod); return c ? Number(c.precio_unit) : null; }
function _monedaActual(prod) { const c = _ultimaCompra(prod); return c ? c.moeda : "R$"; }
function _consumoStats(ventana) {
  ventana = ventana || 30;
  const desde = daysAgo(ventana);
  const enVentana = (state.sacoConsumo || []).filter(c => c.fecha > desde);
  const total = enVentana.reduce((s, c) => s + (parseInt(c.cantidad) || 0), 0);
  const dias = new Set(enVentana.map(c => c.fecha)).size; // días distintos CON consumo registrado
  return { total, dias, prom: dias > 0 ? total / dias : 0 }; // promedio por día con registro
}
function _consumoPromDiario(ventana) { return _consumoStats(ventana).prom; }
function _consumoPorMes() {
  const m = {};
  (state.sacoConsumo || []).forEach(c => { const k = c.fecha.slice(0, 7); m[k] = (m[k] || 0) + (parseInt(c.cantidad) || 0); });
  return m;
}
function _pronosticoProxMes(k) {
  k = k || 3;
  const mesActual = todayISO().slice(0, 7);
  const pm = _consumoPorMes();
  const meses = Object.keys(pm).filter(x => x < mesActual).sort();
  const ult = meses.slice(-k);
  if (!ult.length) return 0;
  return Math.round(ult.reduce((s, m) => s + pm[m], 0) / ult.length);
}

function renderSacosInventario() {
  const cont = $("sacosInventario");
  if (!cont) return;
  const productos = (state.sacoProductos || []).filter(p => p.activo !== false);
  const al = $("sacosAlerta");
  if (!productos.length) {
    cont.innerHTML = '<div class="text-xs text-gray-400">Configurá sacos en \u2699\ufe0f Configuración.</div>';
    if (al) al.classList.add("hidden");
    return;
  }
  const stats = _consumoStats(30);
  const promDiario = stats.prom;
  const alertas = [];
  let totalStock = 0;
  const valorTotal = {};
  const filas = productos.map(p => {
    const stock = _stockActual(p);
    totalStock += stock;
    const label = p.label || (p.nombre + " " + p.kg + "kg");
    const min = Number(p.stock_min) || 0;
    const bajo = min > 0 && stock <= min;
    if (bajo) alertas.push(label + " (" + stock + ")");
    const precio = _precioActual(p);
    let valTxt = "";
    if (precio != null && stock > 0) {
      const m = _monedaActual(p) || "R$";
      const val = stock * precio;
      valorTotal[m] = (valorTotal[m] || 0) + val;
      valTxt = ' \u00b7 <span class="text-gray-500">' + fmtMoeda(val, m) + '</span>';
    }
    const stockTxt = '<b class="' + (bajo ? 'text-rose-700' : 'text-gray-800') + '">' + stock + '</b><span class="text-gray-400 text-xs"> sacos</span>' + valTxt;
    return '<div class="flex items-center justify-between border-b border-gray-100 py-1">' +
      '<span class="flex items-center gap-2"><span class="inline-block w-3 h-3 rounded-full" style="background:' + (p.color || '#9ca3af') + '"></span>' + escapeHtml(label) + '</span>' +
      '<span class="text-sm">' + stockTxt + '</span></div>';
  }).join("");
  let autonomiaHtml = '';
  if (stats.dias < 3) {
    autonomiaHtml = '<div class="text-xs text-gray-500 mt-1">⏳ Autonomía: cargá unos días más de consumo para estimar (' + stats.dias + ' día' + (stats.dias === 1 ? '' : 's') + ' con registro).</div>';
  } else if (promDiario > 0) {
    const dias = Math.round(totalStock / promDiario);
    autonomiaHtml = '<div class="text-xs text-gray-600 mt-1">⏳ Alcanza para ~<b>' + dias + ' días</b> · promedio <b>' + promDiario.toFixed(1) + '</b> sacos/día (según ' + stats.dias + ' días con registro)</div>';
  }
  const valorParts = Object.keys(valorTotal).map(m => fmtMoeda(valorTotal[m], m));
  cont.innerHTML = filas +
    '<div class="flex items-center justify-between mt-2 pt-1 border-t-2 border-amber-300 text-sm">' +
      '<span class="font-bold text-amber-900">Total en stock</span><span class="mono font-bold">' + totalStock + ' sacos</span></div>' +
    (valorParts.length ? '<div class="flex items-center justify-between text-xs text-gray-700 mt-1"><span class="font-semibold">\ud83d\udcb5 Valor del inventario</span><span class="mono font-semibold">' + valorParts.join(" \u00b7 ") + '</span></div>' : '') +
    autonomiaHtml;
  if (al) {
    if (alertas.length) { al.classList.remove("hidden"); al.innerHTML = "\u26a0\ufe0f Stock bajo: " + alertas.map(escapeHtml).join(" \u00b7 "); }
    else al.classList.add("hidden");
  }
}

let _sacoCharts = {};
function _mkSacoChart(id, cfg) {
  const el = $(id); if (!el || typeof Chart === "undefined") return;
  if (_sacoCharts[id]) _sacoCharts[id].destroy();
  _sacoCharts[id] = new Chart(el.getContext("2d"), cfg);
}
function renderSacosAnalitica() {
  // 1) Uso diario últimos 30 días
  const dias = [];
  for (let i = 29; i >= 0; i--) dias.push(daysAgo(i));
  const porDia = {};
  (state.sacoConsumo || []).forEach(c => { porDia[c.fecha] = (porDia[c.fecha] || 0) + (parseInt(c.cantidad) || 0); });
  _mkSacoChart("chartSacoDiario", {
    type: "bar",
    data: { labels: dias.map(d => d.slice(5)), datasets: [{ label: "Sacos/día", data: dias.map(d => porDia[d] || 0), backgroundColor: "#f59e0b" }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
  // 2) Uso mensual (últimos 6)
  const pm = _consumoPorMes();
  const meses = Object.keys(pm).sort().slice(-6);
  _mkSacoChart("chartSacoMensual", {
    type: "bar",
    data: { labels: meses, datasets: [{ label: "Sacos/mes", data: meses.map(m => pm[m]), backgroundColor: "#0891b2" }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
  // 3) Por tipo
  const porTipo = {};
  (state.sacoConsumo || []).forEach(c => { porTipo[c.tipo] = (porTipo[c.tipo] || 0) + (parseInt(c.cantidad) || 0); });
  const tipos = Object.keys(porTipo);
  const colorTipo = (t) => { const p = (state.sacoProductos || []).find(x => x.nombre === t); return p ? p.color : "#9ca3af"; };
  _mkSacoChart("chartSacoTipo", {
    type: "doughnut",
    data: { labels: tipos, datasets: [{ data: tipos.map(t => porTipo[t]), backgroundColor: tipos.map(colorTipo) }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }
  });
  // Pronóstico
  const pron = _pronosticoProxMes(3);
  const pe = $("sacosPronostico");
  if (pe) pe.textContent = pron > 0 ? ("📈 Pronóstico próximo mes: ~" + pron + " sacos (promedio de meses anteriores)") : "Pronóstico: faltan meses de historial.";
  // Costo del período (rango del dashboard)
  const costo = {};
  (state.sacoCompras || []).filter(c => c.fecha >= state.rango.desde && c.fecha <= state.rango.hasta && c.costo != null)
    .forEach(c => { costo[c.moeda] = (costo[c.moeda] || 0) + Number(c.costo); });
  const ce = $("sacosCosto");
  if (ce) {
    const partes = Object.keys(costo).map(m => fmtMoeda(costo[m], m));
    ce.textContent = partes.length ? ("💵 Gastado en trigo (período): " + partes.join(" · ")) : "Sin compras con costo en el período.";
  }
}

// ============================================================
// Aviso de stock bajo de trigo
// El minimo lo define el dueno por saco (campo "min" en Ajustar
// existencia; por defecto 20). La bandera bajo_minimo y los dias
// de cobertura vienen ya calculados de la vista saco_stock_actual.
// ============================================================
let _alertaStockYaMostrada = false;   // el aviso emergente sale una vez por sesion

function sacosBajoMinimo() {
  // 04/10/2026: el mínimo de sacos y los días de aviso se ponen en config.fitmassa.com → 🧾 Caja
  if (!puedeVer("trigo")) return [];
  const diasAlerta = Number((MIS && MIS.ajustes && MIS.ajustes.trigo_dias_alerta) ?? 7) || 0;
  return (state.sacoProductos || []).filter(p => {
    if (p.activo === false) return false;
    const min = Number(p.stock_min) || 0;
    if (min > 0 && _stockActual(p) <= min) return true;
    const d = p.dias_de_cobertura;
    return diasAlerta > 0 && d != null && Number(d) >= 0 && Number(d) < diasAlerta;
  });
}

function renderAlertaStock() {
  const bajos = sacosBajoMinimo();
  const banner = $("alertaStockBanner");
  const texto = $("alertaStockBannerTexto");

  if (!bajos.length) {
    if (banner) banner.classList.add("hidden");
    return;
  }

  // Banner permanente: queda visible mientras el stock siga bajo.
  if (banner && texto) {
    texto.textContent = bajos
      .map(p => (p.label || (p.nombre + " " + p.kg + "kg")) + ": quedan " + _stockActual(p) + (p.dias_de_cobertura != null ? " (~" + p.dias_de_cobertura + " días)" : ""))
      .join(" · ");
    banner.classList.remove("hidden");
  }

  // Aviso emergente: solo la primera vez que entra al panel.
  if (_alertaStockYaMostrada) return;
  _alertaStockYaMostrada = true;
  abrirAlertaStock();
}

function abrirAlertaStock() {
  const bajos = sacosBajoMinimo();
  if (!bajos.length) { toast("El stock de trigo está bien por ahora"); return; }
  const cont = $("alertaStockLista");
  if (!cont) return;
  cont.innerHTML = bajos.map(p => {
    const label = p.label || (p.nombre + " " + p.kg + "kg");
    const stock = _stockActual(p);
    const dias = p.dias_de_cobertura;
    const cuanto = stock <= 0
      ? '<span class="text-red-700 font-bold">sin existencia</span>'
      : 'quedan <b>' + stock + '</b> ' + (stock === 1 ? 'saco' : 'sacos');
    const autonomia = (dias != null && Number(dias) > 0)
      ? '<div class="text-[11px] text-gray-500 mt-0.5">Te alcanza para unos ' + dias + ' días al ritmo actual</div>'
      : '';
    return '<div class="border-2 border-red-200 bg-red-50 rounded-xl p-2.5">' +
      '<div class="font-bold text-sm text-red-800">' + escapeHtml(label) + '</div>' +
      '<div class="text-xs text-red-700 mt-0.5">' + cuanto + ' · mínimo configurado: ' + p.stock_min + '</div>' +
      autonomia +
      '</div>';
  }).join("");
  openModal("modalAlertaStock");
}

// ---- Modales: ajustar existencia / registrar compra ----
function openAjusteStock() {
  const cont = $("ajusteStockList");
  cont.innerHTML = (state.sacoProductos || []).map(p => {
    const label = p.label || (p.nombre + " " + p.kg + "kg");
    const stock = _stockActual(p);
    return '<div class="flex items-center gap-2 text-sm">' +
      '<span class="flex-1">' + escapeHtml(label) + (stock != null ? ' <span class="text-gray-400">(hoy ' + stock + ')</span>' : '') + '</span>' +
      '<input type="number" min="0" step="1" class="ajuste-stock w-20 p-1.5 border-2 border-gray-300 rounded text-center" data-id="' + p.id + '" placeholder="sin cambio"/>' +
      '</div>';
  }).join("");
  openModal("modalAjusteStock");
}
async function guardarAjusteStock() {
  const hoy = todayISO();
  const ups = [];
  document.querySelectorAll(".ajuste-stock").forEach(inp => {
    const id = inp.dataset.id;
    const val = inp.value.trim();
    const minInp = document.querySelector('.ajuste-min[data-id="' + CSS.escape(id) + '"]');
    const patch = {};
    if (val !== "") { patch.stock_base = Number(val); patch.stock_fecha = hoy; }
    if (minInp && minInp.value.trim() !== "") patch.stock_min = Number(minInp.value);
    if (Object.keys(patch).length) ups.push({ id, patch });
  });
  // Antes no revisaba errores: sin señal cerraba y decía "Existencia actualizada" sin haber guardado nada.
  let ok = 0, fallas = [];
  for (const u of ups) {
    const { error } = await sb.from("saco_producto").update(u.patch).eq("id", u.id);
    if (error) fallas.push(error); else ok++;
  }
  if (fallas.length) {
    // El modal queda abierto con lo escrito para poder reintentar.
    toast(errGuardar(fallas[0]) + (ok ? " (" + ok + " de " + ups.length + " sí se guardaron)" : ""), 5000);
    if (ok) reload();
    return;
  }
  closeModal("modalAjusteStock");
  toast("Existencia actualizada (solo los productos que escribiste)");
  reload();
}
function openCompra() {
  const sel = $("compraProducto");
  sel.innerHTML = (state.sacoProductos || []).map(p => '<option value="' + p.nombre + '|' + p.kg + '">' + escapeHtml(p.label || (p.nombre + " " + p.kg + "kg")) + '</option>').join("");
  $("compraFecha").value = todayISO();
  $("compraCantidad").value = "";
  $("compraCosto").value = "";
  openModal("modalCompra");
}
async function guardarCompra() {
  const parts = ($("compraProducto").value || "").split("|");
  const nombre = parts[0], kg = Number(parts[1]);
  const cantidad = parseInt($("compraCantidad").value) || 0;
  if (!nombre || cantidad <= 0) { toast("Elegí el saco y la cantidad"); return; }
  const precio = $("compraCosto").value.trim() !== "" ? Number($("compraCosto").value) : null; // precio POR SACO
  const costo = precio != null ? precio * cantidad : null;                                       // total = precio × cantidad
  const moeda = $("compraMoeda").value || "R$";
  const fecha = $("compraFecha").value || todayISO();
  const { error } = await sb.from("saco_compra").insert({ nombre, kg, cantidad, precio_unit: precio, costo, moeda, fecha });
  if (error) { toast("Error: " + error.message, 4000); return; }
  closeModal("modalCompra");
  toast("Compra registrada");
  reload();
}
function wireSacosInventarioListeners() {
  if ($("btnAjusteStock")) $("btnAjusteStock").addEventListener("click", openAjusteStock);
  if ($("btnRegistrarCompra")) $("btnRegistrarCompra").addEventListener("click", openCompra);
  if ($("ajusteStockGuardar")) $("ajusteStockGuardar").addEventListener("click", guardarAjusteStock);
  if ($("compraGuardar")) $("compraGuardar").addEventListener("click", guardarCompra);
  // Vista previa del total de la compra (precio por saco × cantidad)
  const _updTotal = () => {
    const cant = parseInt(($("compraCantidad") || {}).value) || 0;
    const pre = Number(($("compraCosto") || {}).value) || 0;
    const m = ($("compraMoeda") || {}).value || "R$";
    const el = $("compraTotalPreview");
    if (el) el.textContent = (cant > 0 && pre > 0) ? ("Total: " + fmtMoeda(cant * pre, m) + "  (" + cant + " × " + pre + ")") : "";
  };
  ["compraCantidad", "compraCosto", "compraMoeda"].forEach(id => {
    const e = $(id); if (e) { e.addEventListener("input", _updTotal); e.addEventListener("change", _updTotal); }
  });
}

// ============================================================
// 💳 Formas de pago de la caja: renombrar / mostrar-ocultar / agregar
// ============================================================
const FP_COLUMNAS = ["PIX","Dinheiro","Débito POS","Pago Móvil","Bs efectivo","USD"]; // llaves base (no se borran)
async function fetchFormasPago() {
  const { data } = await sb.from("forma_pago_catalogo").select("*").order("orden");
  state.formasPago = data || [];
}
function renderFormasPagoAdmin() {
  const cont = $("formasPagoAdmin");
  if (!cont) return;
  cont.innerHTML = (state.formasPago || []).map(f => {
    const activo = f.activo !== false;
    const esBase = FP_COLUMNAS.indexOf(f.nombre) >= 0;
    return '<div class="flex items-center gap-1 text-sm">' +
      '<input type="text" class="fp-label flex-1 p-1.5 border-2 border-gray-300 rounded text-sm" data-id="' + f.id + '" value="' + escapeHtml(f.label || f.nombre) + '"/>' +
      '<span class="text-[10px] text-gray-400 w-8 text-center">' + escapeHtml(f.moeda) + '</span>' +
      '<button type="button" data-id="' + f.id + '" data-activo="' + activo + '" class="fp-toggle text-[11px] px-1.5 py-0.5 rounded ' + (activo ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500') + '">' + (activo ? 'visible' : 'oculto') + '</button>' +
      '<button type="button" data-id="' + f.id + '" class="fp-save text-[11px] px-2 py-0.5 rounded bg-amber-600 text-white font-bold">💾</button>' +
      (esBase ? '<span class="text-[10px] text-gray-300 px-1" title="forma base, no se borra">🔒</span>' : '<button type="button" data-id="' + f.id + '" class="fp-del text-rose-600 px-1">🗑</button>') +
      '</div>';
  }).join("") || '<div class="text-[11px] text-gray-400">Sin formas de pago.</div>';
  wireFormasPagoRows();
}
function wireFormasPagoRows() {
  document.querySelectorAll(".fp-save").forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const inp = document.querySelector('.fp-label[data-id="' + CSS.escape(id) + '"]');
    const nuevo = (inp.value || "").trim();
    if (!nuevo) { toast("El nombre no puede quedar vacío"); return; }
    const { error } = await sb.from("forma_pago_catalogo").update({ label: nuevo }).eq("id", id);
    if (error) { toast("Error: " + error.message, 4000); return; }
    await fetchFormasPago(); renderFormasPagoAdmin();
    toast("Nombre actualizado (se ve en la caja)");
  });
  document.querySelectorAll(".fp-toggle").forEach(b => b.onclick = async () => {
    const nuevoActivo = !(b.dataset.activo === "true");
    const { error } = await sb.from("forma_pago_catalogo").update({ activo: nuevoActivo }).eq("id", b.dataset.id);
    if (error) { toast(errGuardar(error), 4000); return; }
    await fetchFormasPago(); renderFormasPagoAdmin();
    toast(nuevoActivo ? "Visible en la caja" : "Oculta en la caja");
  });
  document.querySelectorAll(".fp-del").forEach(b => b.onclick = async () => {
    if (!confirm("¿Archivar esta forma de pago? Deja de verse en la caja; los cierres ya guardados conservan su dato y queda en 🕓 Historial.")) return;
    const { error } = await sb.from("forma_pago_catalogo").delete().eq("id", b.dataset.id); // la base la archiva (activo=false), no la borra
    if (error) { toast(errGuardar(error), 4000); return; }
    await fetchFormasPago(); renderFormasPagoAdmin();
    toast("Forma de pago archivada");
  });
}
// ============================================================
// 👥 Cajeras / colaboradores: renombrar / mostrar-ocultar / agregar / borrar
// ============================================================
async function fetchCajeras() {
  const { data } = await sb.from("cajera").select("*").order("orden");
  state.cajeras = data || [];
}

async function cuentaCierresPorCajera(nombre) {
  // Cuántos cierres en dia_cierre tiene este nombre (para decidir si mostrar 🔒)
  const { count } = await sb
    .from("dia_cierre")
    .select("id", { count: "exact", head: true })
    .eq("cajera", nombre);
  return count || 0;
}

async function renderCajerasAdmin() {
  const cont = $("cajerasAdmin");
  if (!cont) return;
  const lista = (state.cajeras || []);
  if (lista.length === 0) {
    cont.innerHTML = '<div class="text-[11px] text-gray-400">Sin cajeras. Agregá una abajo.</div>';
    return;
  }
  // Para cada cajera, traer su count de cierres en paralelo (solo para mostrar 🔒)
  const counts = await Promise.all(lista.map(c => cuentaCierresPorCajera(c.nombre)));
  cont.innerHTML = lista.map((c, i) => {
    const activo = c.activo !== false;
    const tieneHistorico = counts[i] > 0;
    return '<div class="flex items-center gap-1 text-sm">' +
      '<input type="text" class="cajera-nombre flex-1 p-1.5 border-2 border-gray-300 rounded text-sm" data-id="' + c.id + '" data-original="' + escapeHtml(c.nombre) + '" value="' + escapeHtml(c.nombre) + '"/>' +
      '<button type="button" data-id="' + c.id + '" data-activo="' + activo + '" class="cajera-toggle text-[11px] px-1.5 py-0.5 rounded ' + (activo ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500') + '">' + (activo ? 'visible' : 'oculto') + '</button>' +
      '<button type="button" data-id="' + c.id + '" class="cajera-save text-[11px] px-2 py-0.5 rounded bg-amber-600 text-white font-bold">💾</button>' +
      (tieneHistorico
        ? '<span class="text-[10px] text-gray-300 px-1" title="tiene ' + counts[i] + ' cierre(s) histórico(s) — no se borra">🔒</span>'
        : '<button type="button" data-id="' + c.id + '" class="cajera-del text-rose-600 px-1" title="Borrar">🗑</button>') +
      '</div>';
  }).join("");
  wireCajerasRows();
}

function wireCajerasRows() {
  // Guardar nombre (renombrar)
  document.querySelectorAll(".cajera-save").forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const inp = document.querySelector('.cajera-nombre[data-id="' + CSS.escape(id) + '"]');
    const nuevo = (inp.value || "").trim();
    const original = inp.dataset.original;
    if (!nuevo) { toast("El nombre no puede quedar vacío"); return; }
    if (nuevo === original) { toast("Sin cambios"); return; }
    // Si la cajera tiene cierres históricos, avisar que no se cambia retroactivamente
    const histor = await cuentaCierresPorCajera(original);
    if (histor > 0 && !confirm(`"${original}" tiene ${histor} cierre(s) histórico(s) con su nombre actual.\n\nSi renombrás, los cierres viejos siguen mostrando "${original}" — solo cambia el nombre para los próximos.\n\n¿Continuar?`)) return;
    const { error } = await sb.from("cajera").update({ nombre: nuevo }).eq("id", id);
    if (error) { toast(error.message.includes("duplicate") ? "Ya hay otra cajera con ese nombre" : "Error: " + error.message, 4000); return; }
    await fetchCajeras(); renderCajerasAdmin();
    toast("Nombre actualizado (aparece en la caja)");
  });

  // Activo/oculto
  document.querySelectorAll(".cajera-toggle").forEach(b => b.onclick = async () => {
    const nuevoActivo = !(b.dataset.activo === "true");
    if (!nuevoActivo && !confirm("¿Ocultar esta cajera? Deja de aparecer en el select. Los cierres viejos NO se borran.")) return;
    const { error } = await sb.from("cajera").update({ activo: nuevoActivo }).eq("id", b.dataset.id);
    if (error) { toast("Error: " + error.message, 4000); return; }
    await fetchCajeras(); renderCajerasAdmin();
    toast(nuevoActivo ? "Visible en la caja" : "Oculta en la caja");
  });

  // Borrar (solo si NO tiene histórico)
  document.querySelectorAll(".cajera-del").forEach(b => b.onclick = async () => {
    if (!confirm("¿Archivar esta cajera? Deja de aparecer en la caja y queda guardada en 🕓 Historial.")) return;
    const { error } = await sb.from("cajera").delete().eq("id", b.dataset.id); // la base la archiva (activo=false), no la borra
    if (error) { toast("Error: " + error.message, 4000); return; }
    await fetchCajeras(); renderCajerasAdmin();
    toast("Cajera archivada");
  });
}

function wireCajerasListeners() {
  const add = $("addCajeraBtn");
  if (add) add.addEventListener("click", async () => {
    const nombre = ($("nuevaCajeraNombre").value || "").trim();
    if (!nombre) { toast("Poné un nombre"); return; }
    const orden = (state.cajeras?.length || 0) + 1;
    const { error } = await sb.from("cajera").insert({ nombre, orden, activo: true });
    if (error) { toast(error.message.includes("duplicate") ? "Ya existe una cajera con ese nombre" : "Error: " + error.message, 4000); return; }
    $("nuevaCajeraNombre").value = "";
    await fetchCajeras(); renderCajerasAdmin();
    toast("Cajera agregada (aparece en la caja)");
  });
  const inp = $("nuevaCajeraNombre");
  if (inp) inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); add?.click(); }
  });
}

function wireFormasPagoListeners() {
  const add = $("addFpBtn");
  if (add) add.addEventListener("click", async () => {
    const nombre = ($("nuevaFpNombre").value || "").trim();
    const moeda = $("nuevaFpMoeda").value || "R$";
    if (!nombre) { toast("Poné un nombre"); return; }
    if (FP_COLUMNAS.indexOf(nombre) >= 0) { toast("Ese nombre es reservado, usá otro"); return; }
    const orden = (state.formasPago.length || 0) + 1;
    const { error } = await sb.from("forma_pago_catalogo").insert({ nombre, label: nombre, moeda, preset: false, activo: true, orden });
    if (error) { toast(error.message.includes("duplicate") ? "Esa forma ya existe" : "Error: " + error.message, 4000); return; }
    $("nuevaFpNombre").value = "";
    await fetchFormasPago(); renderFormasPagoAdmin();
    toast("Forma de pago agregada (aparece en la caja)");
  });
}

function init() {
  // 27/09/2026: 💱 tasa central — el dueño o quien tenga el permiso la cambia aquí con su PIN (queda registrado).
  // Los cierres ya guardados conservan su propia tasa: cambiarla no altera los días pasados de este panel.
  const _tc = montarCambioTasa($("tasaCentral"), {
    url: SUPABASE_URL, key: SUPABASE_ANON_KEY, app: "caja_admin",
    onCambio: () => { if (typeof toast === "function") toast("💱 Tasa nueva guardada. Los cierres pasados conservan su tasa."); },
  });
  cargarTasaVigente(SUPABASE_URL, SUPABASE_ANON_KEY).then(() => _tc && _tc.pintar());

  // Rango default: últimos 30 días
  setRango(daysAgo(30), todayISO());

  $("fechaDesde").addEventListener("change", e => {
    state.rango.desde = e.target.value;
    reload();
  });
  $("fechaHasta").addEventListener("change", e => {
    state.rango.hasta = e.target.value;
    reload();
  });

  document.querySelectorAll(".range-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.range);
      setRango(daysAgo(n), todayISO());
    });
  });

  $("refreshBtn").addEventListener("click", reload);

  // Aviso de stock bajo: el banner reabre el detalle; el botón lleva a ajustar.
  const _ab = $("alertaStockBannerBtn");
  if (_ab) _ab.addEventListener("click", abrirAlertaStock);
  const _aa = $("alertaStockAjustar");
  // 04/10/2026 (pedido de Polley): el aviso no ofrece ajustar existencia, ofrece COMPRAR
  if (_aa) _aa.addEventListener("click", () => { closeModal("modalAlertaStock"); openCompra(); });

  document.querySelectorAll(".chart-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.chartMode = btn.dataset.chart;
      document.querySelectorAll(".chart-btn").forEach(b => {
        b.classList.remove("bg-amber-500", "text-white");
        b.classList.add("bg-gray-200");
      });
      btn.classList.remove("bg-gray-200");
      btn.classList.add("bg-amber-500", "text-white");
      renderChart();
    });
  });

  $("exportCsvBtn").addEventListener("click", exportCSV);

  $("toggleAllBtn").addEventListener("click", () => {
    state.allExpanded = !state.allExpanded;
    if (state.allExpanded) {
      state.cierres.forEach(c => state.expanded.add(c.id));
      $("toggleAllBtn").textContent = "Colapsar todo";
    } else {
      state.expanded.clear();
      $("toggleAllBtn").textContent = "Expandir todo";
    }
    renderDias();
  });

  $("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem("oimira_admin_pin_until");
    localStorage.removeItem("oimira_admin_quien");
    localStorage.removeItem("oimira_admin_token");
    location.reload();
  });

  // Online/offline indicator
  window.addEventListener("online", () => setStatus("online", "Conectado"));
  window.addEventListener("offline", () => setStatus("offline", "Sin conexión"));

  // El refresco automático fue desactivado — solo al iniciar o con el botón 🔄
  // Así no se colapsan los detalles si estás leyendo o haciendo scroll.

  // Wire del módulo de caja (modales, retiros, etc)
  wireCajaListeners();
  // Wire del generador de códigos
  wireCodigoListeners();
  // Wire de la gestión de catálogo de sacos (administrativo)
  wireSacosListeners();
  wireSacosInventarioListeners();
  wireFormasPagoListeners();
  wireCajerasListeners();
  // 04/10/2026: pestañas, buscador de cierres e historial
  wirePestanas();
  wireBuscadorCierres();
  wireHistorial();
}

// ============================================================
// 🗂 Pestañas (04/10/2026) — una sección a la vez, barra fija abajo (uso en teléfono)
// ============================================================
let TAB_ACTUAL = "resumen";
function mostrarTab(t) {
  if (!puedeVer(t)) t = TABS_ORDEN.find(puedeVer) || "sinpermiso";
  TAB_ACTUAL = t;
  document.querySelectorAll(".tab-panel").forEach(p => {
    const en = (p.dataset.panel || "").split(/\s+/).includes(t);
    p.classList.toggle("tab-oculto", !en);
  });
  const tabBarra = t === "movimientos" ? "ajustes" : t; // Movimientos vive dentro de Ajustes
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("activa", b.dataset.tab === tabBarra));
  window.scrollTo(0, 0);
  // Los gráficos dibujados mientras su pestaña estaba oculta quedan en 0×0: se reajustan al mostrarse
  requestAnimationFrame(() => {
    try { const C = window.Chart; if (C && C.instances) Object.values(C.instances).forEach(ch => { try { ch.resize(); } catch (e) { /* */ } }); } catch (e) { /* */ }
  });
  if (t === "movimientos") { if (PUEDE_MOV) cargarHistorial(true); else mostrarTab("ajustes"); }
  if (t === "analisis") cargarAnalisis();
}
// Qué puede ver el que entró + avisos (todo se decide en config.fitmassa.com). Copia local para trabajar sin señal.
const MIS_KEY = "caja_admin_permisos_v1";
let MIS = null;
try { MIS = JSON.parse(localStorage.getItem(MIS_KEY) || "null"); } catch (e) { MIS = null; }
const TABS_ORDEN = ["resumen", "cierres", "trigo", "dinero", "analisis", "ajustes"];
function puedeVer(t) {
  if (t === "sinpermiso") return true;
  if (!MIS || !MIS.ver) return false;
  if (t === "movimientos") return !!MIS.ver.movimientos;
  return !!MIS.ver[t];
}
function aplicarPermisos() {
  // Sin permiso: el botón queda en gris claro y no se puede tocar (sin mensajes). Lo decide el dueño en config.
  document.querySelectorAll(".tab-btn").forEach(b => { const ok = puedeVer(b.dataset.tab); b.classList.toggle("bloqueada", !ok); b.disabled = !ok; });
  PUEDE_MOV = puedeVer("movimientos");
  const a = $("movAcceso"); if (a) { a.classList.toggle("bloqueada", !PUEDE_MOV); const ab = $("movAbrir"); if (ab) ab.disabled = !PUEDE_MOV; }
  if (TAB_ACTUAL === "sinpermiso" || !puedeVer(TAB_ACTUAL)) mostrarTab(TABS_ORDEN.find(puedeVer) || "sinpermiso");
  else mostrarTab(TAB_ACTUAL);
  renderAlertaStock();
}
async function cargarMisPermisos() {
  try {
    const { data, error } = await sbPagos.rpc("caja_mis_permisos");
    if (!error && data) { MIS = data; try { localStorage.setItem(MIS_KEY, JSON.stringify(data)); } catch (e) { /* */ } }
    else if (!error && data === null) { MIS = null; try { localStorage.removeItem(MIS_KEY); } catch (e) { /* */ } }
  } catch (e) { /* sin señal: se usa la copia */ }
  aplicarPermisos();
  cargarResumen().catch(() => {});
}
function wirePestanas() {
  document.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => mostrarTab(b.dataset.tab)));
  TAB_ACTUAL = "resumen";
  aplicarPermisos();
  cargarMisPermisos();
}

// ============================================================
// 📅 Ir directo a un cierre (Hoy / Ayer / Otro día) + buscador
// ============================================================
function sumarDias(iso, n) {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
async function irADia(fecha) {
  if (!puedeVer("cierres")) return;
  mostrarTab("cierres");
  if ($("buscarCierre")) $("buscarCierre").value = "";
  state.rango.desde = fecha; state.rango.hasta = fecha;
  $("fechaDesde").value = fecha; $("fechaHasta").value = fecha;
  await reload({ preserveExpanded: false });
  state.cierres.forEach(c => state.expanded.add(c.id));
  renderDias();
  const info = $("buscarInfo");
  if (info) info.textContent = state.cierres.length
    ? "Cierre del " + fmtFecha(fecha) + ". Para ver más días toca 7d / 30d arriba."
    : "No hay cierre guardado para el " + fmtFecha(fecha) + ".";
}
function wireBuscadorCierres() {
  document.querySelectorAll(".ir-dia").forEach(b => b.addEventListener("click", () => irADia(b.dataset.ir === "hoy" ? todayISO() : daysAgo(1))));
  const f = $("irFecha");
  if (f) { f.max = todayISO(); f.addEventListener("change", () => { if (f.value) irADia(f.value); }); }
  const q = $("buscarCierre");
  if (q) { let t; q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(renderDias, 150); }); }
}

// ============================================================
// 🏠 Resumen corto (04/10/2026): lo primero que ve el dueño
// Ventas = "Gran Total" en R$ con la tasa de cada día; gastos igual. Todo sale de los cierres guardados.
// ============================================================
function _sacosDe(c) {
  const n = (c.dia_saco || []).reduce((s, x) => s + (parseInt(x.cantidad) || 0), 0);
  return n || Number(c.sacos_trigo || 0);
}
function _sumar(lista) {
  const r = { v: 0, g: 0, t: 0, s: 0, n: 0 };
  for (const c of lista) { const k = calcCierre(c); r.v += k.granTotalRs; r.g += k.gastosTotalRs; r.t += Number(c.tickets || 0); r.s += _sacosDe(c); r.n++; }
  r.neto = r.v - r.g;
  return r;
}
function _delta(a, b, txt) {
  if (!(b > 0)) return `<span class="rs-sub">sin datos para comparar ${txt}</span>`;
  const p = (a - b) / b * 100;
  const cls = Math.abs(p) < 1 ? "rs-flat" : p > 0 ? "rs-up" : "rs-down";
  const fl = Math.abs(p) < 1 ? "＝" : p > 0 ? "▲" : "▼";
  return `<span class="${cls} font-bold">${fl} ${Math.abs(p).toFixed(0)}%</span> <span class="rs-sub">${txt}</span>`;
}
const _r0 = (n) => "R$ " + Math.round(Number(n) || 0).toLocaleString("es-AR");
async function cargarResumen() {
  const cont = $("resumenCont");
  if (!cont) return;
  const hoy = todayISO(), ayer = daysAgo(1);
  const iniMes = hoy.slice(0, 8) + "01";
  const iniMesPrev = sumarDias(iniMes, -1).slice(0, 8) + "01";
  const desde = [iniMesPrev, sumarDias(hoy, -15)].sort()[0];
  const [rc, rr] = await Promise.all([
    sb.from("dia_cierre").select("*,forma_pago_extra(*),dia_gasto(*),dia_saco(*)").gte("fecha", desde).lte("fecha", hoy).order("fecha", { ascending: false }),
    sb.from("caja_retiro").select("monto,moeda,fecha").gte("fecha", iniMes).lte("fecha", hoy),
  ]);
  if (rc.error) { cont.innerHTML = `<div class="rs-card text-sm text-red-700">No se pudo cargar el resumen: ${escapeHtml(rc.error.message)}</div>`; return; }
  const cierres = rc.data || [];
  const porFecha = new Map(); cierres.forEach(c => { if (!porFecha.has(c.fecha)) porFecha.set(c.fecha, []); porFecha.get(c.fecha).push(c); });
  const entre = (a, b) => cierres.filter(c => c.fecha >= a && c.fecha <= b);
  const alertas = [];

  // 1) Último cierre (hoy si ya cerraron, si no ayer)
  let html = "";
  const ult = cierres[0];
  const AJ = (MIS && MIS.ajustes) || {};
  if (!puedeVer("resumen")) { cont.innerHTML = ""; return; }
  if (AJ.avisar_cierre_faltante !== false && !porFecha.has(ayer)) alertas.push({ c: "bg-red-50 border-2 border-red-300 text-red-800", t: `⚠️ <span><b>Falta el cierre de ayer</b> (${fmtFecha(ayer)}). Revisa con la cajera.</span>` });
  if (ult) {
    const L = ult.fecha;
    const dia = _sumar(porFecha.get(L));
    const ant = _sumar(porFecha.get(sumarDias(L, -7)) || []);
    const nombre = L === hoy ? "Hoy" : L === ayer ? "Ayer" : "Último cierre";
    const tprom = dia.t > 0 ? dia.v / dia.t : 0;
    html += `<div class="rs-card">
      <div class="flex justify-between items-baseline"><div class="text-sm font-bold text-amber-800">📅 ${nombre} · ${fmtFecha(L)}</div><div class="rs-sub">👤 ${escapeHtml(ult.cajera || "—")}</div></div>
      <div class="rs-big mono text-green-700 mt-1">${_r0(dia.v)}</div>
      <div class="text-xs mt-0.5">${_delta(dia.v, ant.v, "vs el " + fmtFecha(sumarDias(L, -7)))}</div>
      <div class="rs-grid mt-2">
        <div class="rs-mini"><span class="rs-sub">Gastos</span><b class="mono text-red-700">${_r0(dia.g)}</b></div>
        <div class="rs-mini"><span class="rs-sub">Queda</span><b class="mono ${dia.neto < 0 ? "text-red-700" : "text-green-700"}">${_r0(dia.neto)}</b></div>
        <div class="rs-mini"><span class="rs-sub">🌾 Sacos</span><b>${dia.s}</b></div>
      </div>
      <div class="rs-sub mt-1">${dia.t ? `🎫 ${dia.t} tickets · promedio ${fmtR(tprom)}` : ""}</div>
      <button type="button" class="rs-ver mt-2 w-full py-2.5 ${puedeVer("cierres") ? "bg-amber-600 text-white" : "bg-gray-100 text-gray-300 pointer-events-none"} rounded-xl font-bold text-sm" data-fecha="${L}" ${puedeVer("cierres") ? "" : "disabled"}>Ver el cierre completo ›</button>
    </div>`;
  } else {
    html += `<div class="rs-card text-sm text-gray-600">Todavía no hay cierres en los últimos días.</div>`;
  }

  // 2) Últimos 7 días vs los 7 anteriores (salud del negocio)
  const L7 = ult ? ult.fecha : hoy;
  const s7 = _sumar(entre(sumarDias(L7, -6), L7));
  const p7 = _sumar(entre(sumarDias(L7, -13), sumarDias(L7, -7)));
  const pctGasto = s7.v > 0 ? (s7.g / s7.v * 100) : 0;
  html += `<div class="rs-card">
    <div class="text-sm font-bold text-amber-800">📈 Últimos 7 días <span class="rs-sub">(${fmtFecha(sumarDias(L7, -6))} – ${fmtFecha(L7)})</span></div>
    <div class="flex items-end justify-between mt-1"><div class="rs-big mono text-green-700">${_r0(s7.v)}</div><div class="text-xs text-right">${_delta(s7.v, p7.v, "vs semana anterior")}</div></div>
    <div class="rs-grid mt-2">
      <div class="rs-mini"><span class="rs-sub">Gastos</span><b class="mono text-red-700">${_r0(s7.g)}</b><span class="rs-sub">${pctGasto.toFixed(0)}% de la venta</span></div>
      <div class="rs-mini"><span class="rs-sub">Queda</span><b class="mono ${s7.neto < 0 ? "text-red-700" : "text-green-700"}">${_r0(s7.neto)}</b><span class="rs-sub">${_delta(s7.neto, p7.neto, "")}</span></div>
      <div class="rs-mini"><span class="rs-sub">Venta por saco</span><b class="mono">${s7.s ? _r0(s7.v / s7.s) : "—"}</b><span class="rs-sub">${s7.s} sacos</span></div>
    </div>
    <div class="rs-sub mt-1">Promedio por día: <b>${s7.n ? _r0(s7.v / s7.n) : "—"}</b> · ${s7.n} días con cierre</div>
  </div>`;
  const umbral = Number(AJ.umbral_gastos_pct ?? 40) || 40;
  if (s7.v > 0 && pctGasto >= umbral) alertas.push({ c: "bg-amber-50 border-2 border-amber-300 text-amber-900", t: `💸 <span>Los gastos de la semana son el <b>${pctGasto.toFixed(0)}%</b> de la venta. Revisa en 💰 Dinero → Gastos por categoría.</span>` });

  // 3) Mes en curso vs el mismo tramo del mes anterior
  // Se compara hasta el último día con cierre (si hoy todavía no cerraron, no cuenta como día "en cero")
  const finMes = ult && ult.fecha >= iniMes ? ult.fecha : hoy;
  const nDia = Number(finMes.slice(8, 10));
  const finPrev = sumarDias(iniMesPrev, nDia - 1) < iniMes ? sumarDias(iniMesPrev, nDia - 1) : sumarDias(iniMes, -1);
  const sm = _sumar(entre(iniMes, finMes));
  const pm = _sumar(entre(iniMesPrev, finPrev));
  const ret = {}; (rr.data || []).forEach(x => { ret[x.moeda] = (ret[x.moeda] || 0) + Number(x.monto || 0); });
  const retTxt = Object.keys(ret).length ? Object.keys(ret).map(m => fmtMoeda(ret[m], m)).join(" · ") : "ninguno";
  html += `<div class="rs-card">
    <div class="text-sm font-bold text-amber-800">🗓 Este mes <span class="rs-sub">(1 al ${nDia})</span></div>
    <div class="flex items-end justify-between mt-1"><div class="rs-big mono text-green-700">${_r0(sm.v)}</div><div class="text-xs text-right">${_delta(sm.v, pm.v, "vs mismos días del mes pasado")}</div></div>
    <div class="rs-sub mt-1">Gastos ${_r0(sm.g)} · Queda <b class="${sm.neto < 0 ? "text-red-700" : "text-green-700"}">${_r0(sm.neto)}</b> · 🌾 ${sm.s} sacos</div>
    <div class="rs-sub">💸 Retiros del mes: <b>${retTxt}</b></div>
  </div>`;

  // 4) Trigo
  const prods = (state.sacoProductos || []).filter(p => p.activo);
  if (prods.length) {
    const filas = prods.map(p => {
      const st = _stockActual(p), dias = p.dias_de_cobertura, bajo = p.bajo_minimo || (Number(p.stock_min) > 0 && st <= Number(p.stock_min));
      return `<div class="flex justify-between items-center py-1 border-b border-amber-100 last:border-0">
        <span class="text-sm">${escapeHtml(p.label || (p.nombre + " " + p.kg + "kg"))}</span>
        <span class="text-right"><b class="mono ${bajo ? "text-red-700" : "text-gray-800"}">${st}</b> <span class="rs-sub">sacos${dias != null && Number(dias) >= 0 ? " · ~" + dias + " días" : ""}</span></span></div>`;
    }).join("");
    html += `<div class="rs-card"><div class="flex justify-between items-center"><div class="text-sm font-bold text-amber-800">🌾 Trigo</div>
      <button type="button" class="rs-tab text-xs font-semibold ${puedeVer("trigo") ? "text-amber-700" : "text-gray-300 pointer-events-none"}" data-tab="trigo" ${puedeVer("trigo") ? "" : "disabled"}>Ver más ›</button></div>${filas}</div>`;
    // (el aviso de stock bajo ya sale arriba, en la franja roja global)
  }
  const ultCompra = (state.sacoCompras || []).map(c => c.fecha).sort().pop();
  const diasSinCompra = Number(AJ.dias_sin_compra ?? 30) || 0;
  if (diasSinCompra > 0 && ultCompra && ultCompra < sumarDias(hoy, -diasSinCompra)) alertas.push({ c: "bg-sky-50 border-2 border-sky-300 text-sky-900", t: `🛒 <span>La última compra de trigo registrada es del <b>${fmtFecha(ultCompra)}</b>. Si compraste después, regístrala en 🌾 Trigo para que el inventario cuadre.</span>` });

  const alHtml = alertas.map(a => `<div class="rs-alerta ${a.c}">${a.t}</div>`).join("");
  cont.innerHTML = alHtml + html + `<p class="rs-sub text-center">Ventas y gastos en R$ con la tasa de cada día. Actualizado ${new Date().toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" })}.</p>`;
  cont.querySelectorAll(".rs-ver").forEach(b => b.addEventListener("click", () => irADia(b.dataset.fecha)));
  cont.querySelectorAll(".rs-tab").forEach(b => b.addEventListener("click", () => mostrarTab(b.dataset.tab)));
}

// ============================================================
// 📊 Análisis (04/10/2026): estudiar el histórico para saber qué funcionó y prepararse para lo que viene.
// Datos: public.caja_analisis() → días (venta y gastos en R$ con la tasa de cada día, sacos, tickets) + calendario
// de feriados y fechas especiales (director_nomina.feriados, se administra en config → 📅 Calendario).
// ============================================================
const DOW_NOM = ["", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
let _anChart = null, _anCargado = 0;
function _media(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function _pct(a, b) { return b > 0 ? (a / b - 1) * 100 : null; }
function _pctTxt(p) { if (p == null) return "—"; const r = Math.round(p); return `<b class="${r > 2 ? "rs-up" : r < -2 ? "rs-down" : "rs-flat"}">${r > 0 ? "+" : ""}${r}%</b>`; }
// Feriados de Brasil: color verde y banderita (pedido de Polley). VE+BR = cae el mismo día en los dos países.
// Banderas dibujadas (los emoji de bandera no se ven en Windows: salen "BR"/"VE")
const FLAG_BR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 14" width="20" height="14" style="display:inline-block;vertical-align:-2px;border-radius:2px"><rect width="20" height="14" fill="#009c3b"/><path d="M10 1.6 18.2 7 10 12.4 1.8 7z" fill="#ffdf00"/><circle cx="10" cy="7" r="3" fill="#002776"/></svg>';
const FLAG_VE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 14" width="20" height="14" style="display:inline-block;vertical-align:-2px;border-radius:2px"><rect width="20" height="14" fill="#cf142b"/><rect width="20" height="9.33" fill="#00247d"/><rect width="20" height="4.67" fill="#ffcc00"/></svg>';
function _bandera(c) { return c.pais === "BR" ? FLAG_BR : c.pais === "VE+BR" ? FLAG_VE + " " + FLAG_BR : FLAG_VE; }
function _grupo(c) { return c.pais === "BR" ? "brasil" : c.tipo; }
function _estiloBR(c) { return c.pais === "BR" ? ' style="background:#ecfdf5;box-shadow:inset 3px 0 0 #16a34a"' : c.pais === "VE+BR" ? ' style="background:#fefce8;box-shadow:inset 3px 0 0 #16a34a"' : ""; }
function _nomCal(c) { return escapeHtml(String(c.nombre || "").replace(/^🇧🇷\s*/, "")) + (c.nombre_br && c.pais !== "BR" ? `<div class="rs-sub" style="color:#15803d">${FLAG_BR} ${escapeHtml(c.nombre_br)}</div>` : c.pais === "BR" && c.nombre_br ? `<div class="rs-sub" style="color:#15803d">${escapeHtml(c.nombre_br)}</div>` : ""); }
function _dowIso(iso) { const d = new Date(iso + "T12:00:00Z").getUTCDay(); return d === 0 ? 7 : d; }
async function cargarAnalisis(forzar) {
  const cont = $("anCont"); if (!cont) return;
  if (!forzar && Date.now() - _anCargado < 60000) return;
  const { data, error } = await sbPagos.rpc("caja_analisis");
  if (error || !data) { cont.innerHTML = `<div class="rs-card text-sm text-red-700">No se pudo cargar el análisis${error ? ": " + escapeHtml(error.message) : ""}.</div>`; return; }
  _anCargado = Date.now();
  const hoy = todayISO();
  const dias = (data.dias || []).filter(d => d.v > 0);
  const cal = data.calendario || [];
  const esp = new Map(cal.map(c => [c.f, c]));
  if (dias.length < 7) { cont.innerHTML = `<div class="rs-card text-sm">Todavía hay pocos cierres para analizar.</div>`; return; }
  const normales = dias.filter(d => !esp.has(d.f));
  // Promedios por día de la semana (sin días especiales)
  const porDow = {}; for (let i = 1; i <= 7; i++) { const x = normales.filter(d => d.dow === i); porDow[i] = { n: x.length, v: _media(x.map(d => d.v)), g: _media(x.map(d => d.g)), s: _media(x.map(d => d.s)), t: _media(x.map(d => d.t)) }; }
  const ult30 = dias.filter(d => d.f > sumarDias(hoy, -31));
  const ventaPorSaco = (() => { const s = ult30.reduce((a, d) => a + d.s, 0); return s ? ult30.reduce((a, d) => a + d.v, 0) / s : 0; })();
  const ordenDow = [1, 2, 3, 4, 5, 6, 7].sort((a, b) => porDow[b].v - porDow[a].v);
  let html = `<div class="rs-card"><div class="text-sm font-bold text-amber-800">📊 Análisis del negocio</div>
    <div class="rs-sub">Con ${dias.length} cierres (desde ${fmtFecha(dias[0].f)}). Ventas y gastos en R$ con la tasa de cada día. Mientras más días se guarden, más seguros son los cálculos.</div></div>`;
  // 1) Día de la semana
  html += `<div class="rs-card"><div class="text-sm font-bold text-amber-800">📅 ¿Qué días se vende más?</div>
    <div class="rs-sub mb-1">Promedio por día normal (sin feriados ni fechas especiales).</div>
    <div style="height:150px"><canvas id="anChartDow"></canvas></div>
    <table class="an-tbl mt-2"><tr><th>Día</th><th class="n">Venta</th><th class="n">Gastos</th><th class="n">Sacos</th><th class="n">Días</th></tr>
    ${[1, 2, 3, 4, 5, 6, 7].map(i => `<tr><td>${DOW_NOM[i]}${i === ordenDow[0] ? " 🏆" : i === ordenDow[6] ? " 🔻" : ""}</td><td class="n mono">${_r0(porDow[i].v)}</td><td class="n mono">${_r0(porDow[i].g)}</td><td class="n">${porDow[i].s.toFixed(1)}</td><td class="n">${porDow[i].n}</td></tr>`).join("")}</table>`;
  const fs = normales.filter(d => d.dow >= 6), sem = normales.filter(d => d.dow <= 5);
  html += `<div class="rs-sub mt-2">Fin de semana: <b>${_r0(_media(fs.map(d => d.v)))}</b>/día · Lunes a viernes: <b>${_r0(_media(sem.map(d => d.v)))}</b>/día (${_pctTxt(_pct(_media(fs.map(d => d.v)), _media(sem.map(d => d.v))))} el fin de semana).</div></div>`;
  // 2) Momento del mes (quincenas)
  const tramos = [["Días 1–5", 1, 5], ["Días 6–14", 6, 14], ["Días 15–20", 15, 20], ["Días 21–31", 21, 31]];
  const baseDow = (d) => porDow[d.dow].v || 1;
  const tr = tramos.map(([n, a, b]) => { const x = normales.filter(d => { const k = Number(d.f.slice(8, 10)); return k >= a && k <= b; }); return { n, k: x.length, p: _media(x.map(d => (d.v / baseDow(d) - 1) * 100)) }; });
  html += `<div class="rs-card"><div class="text-sm font-bold text-amber-800">🗓 ¿Influye el momento del mes? (quincenas)</div>
    <div class="rs-sub mb-1">Cuánto se vende en cada tramo comparado con lo normal de ese día de la semana.</div>
    <table class="an-tbl"><tr><th>Tramo</th><th class="n">vs normal</th><th class="n">Días</th></tr>${tr.map(x => `<tr><td>${x.n}</td><td class="n">${_pctTxt(x.k ? x.p : null)}</td><td class="n">${x.k}</td></tr>`).join("")}</table></div>`;
  // 3) Fechas especiales que ya pasaron
  const pasadas = cal.filter(c => c.f <= hoy).map(c => {
    const d = dias.find(x => x.f === c.f); if (!d) return null;
    const pv = porDow[d.dow]; const vis = dias.find(x => x.f === sumarDias(c.f, -1));
    return { c, d, pv: _pct(d.v, pv.v), ps: _pct(d.s, pv.s), pvis: vis ? _pct(vis.v, porDow[vis.dow].v) : null };
  }).filter(Boolean);
  const factorTipo = {}; ["feriado", "importante", "evento", "brasil"].forEach(t => { const x = pasadas.filter(p => _grupo(p.c) === t && p.pv != null); factorTipo[t] = x.length ? _media(x.map(p => p.pv)) : null; });
  html += `<div class="rs-card"><div class="text-sm font-bold text-amber-800">🎉 Feriados y fechas especiales: ¿cómo nos fue?</div>
    <div class="rs-sub mb-1">Venta del día comparada con un ${"día normal"} de la misma semana; "Víspera" = el día antes.</div>
    ${pasadas.length ? `<table class="an-tbl"><tr><th>Fecha</th><th class="n">Venta</th><th class="n">vs normal</th><th class="n">Víspera</th></tr>
      ${pasadas.slice().reverse().map(p => `<tr${_estiloBR(p.c)}><td>${_bandera(p.c)} <b>${_nomCal(p.c)}</b><div class="rs-sub">${fmtFecha(p.c.f)} · ${p.c.pais === "BR" ? "feriado de Brasil" : p.c.tipo === "feriado" ? "feriado" : p.c.tipo === "importante" ? "fecha especial" : escapeHtml(p.c.tipo || "")} · 🌾 ${p.d.s}</div></td><td class="n mono">${_r0(p.d.v)}</td><td class="n">${_pctTxt(p.pv)}</td><td class="n">${_pctTxt(p.pvis)}</td></tr>`).join("")}</table>
      <div class="rs-sub mt-2">En promedio frente a un día normal: ${FLAG_VE} feriados ${_pctTxt(factorTipo.feriado)} · ⭐ fechas especiales ${_pctTxt(factorTipo.importante)} · <span style="color:#15803d">${FLAG_BR} feriados de Brasil</span> ${_pctTxt(factorTipo.brasil)}${factorTipo.evento != null ? " · 🎪 eventos " + _pctTxt(factorTipo.evento) : ""}.</div>`
      : `<div class="rs-sub">Todavía no hay fechas especiales con cierre guardado.</div>`}</div>`;
  // 4) Próximas fechas: pronóstico
  const prox = cal.filter(c => c.f > hoy && c.f <= sumarDias(hoy, 90));
  html += `<div class="rs-card"><div class="text-sm font-bold text-amber-800">🔮 Próximas fechas: cómo prepararse</div>
    <div class="rs-sub mb-1">Estimado = lo normal de ese día de la semana ajustado por lo que pasó en fechas parecidas (la misma fecha del año pasado si existe). Sacos = venta estimada ÷ ${ventaPorSaco ? _r0(ventaPorSaco) : "—"} por saco (últimos 30 días).</div>
    ${prox.length ? `<table class="an-tbl"><tr><th>Fecha</th><th class="n">Venta est.</th><th class="n">Sacos</th></tr>
      ${prox.map(c => {
        const dw = _dowIso(c.f), base = porDow[dw].v;
        const mismo = pasadas.find(p => p.c.nombre === c.nombre && p.c.f.slice(5) === c.f.slice(5));
        const f = mismo ? mismo.pv : (factorTipo[_grupo(c)] ?? factorTipo[c.tipo] ?? 0);
        const est = base * (1 + (f || 0) / 100), sac = ventaPorSaco ? Math.round(est / ventaPorSaco) : null;
        return `<tr${_estiloBR(c)}><td>${_bandera(c)} <b>${_nomCal(c)}</b><div class="rs-sub">${fmtFecha(c.f)} · ${f == null ? "sin historia" : (mismo ? "como el año pasado " : "como otras fechas ") + (f > 0 ? "+" : "") + Math.round(f) + "%"}</div></td><td class="n mono">${_r0(est)}</td><td class="n">${sac ?? "—"}</td></tr>`;
      }).join("")}</table>` : `<div class="rs-sub">No hay fechas especiales en los próximos 90 días. Se cargan en Configuración → 📅 Calendario.</div>`}</div>`;
  // 5) Por mes
  const meses = {}; dias.forEach(d => { const k = d.f.slice(0, 7); (meses[k] = meses[k] || []).push(d); });
  html += `<div class="rs-card"><div class="text-sm font-bold text-amber-800">📈 Mes a mes</div>
    <table class="an-tbl"><tr><th>Mes</th><th class="n">Venta</th><th class="n">Gastos</th><th class="n">Prom./día</th><th class="n">Sacos</th></tr>
    ${Object.keys(meses).sort().reverse().map(k => { const x = meses[k]; const v = x.reduce((a, d) => a + d.v, 0), g = x.reduce((a, d) => a + d.g, 0);
      return `<tr><td>${k}${k === hoy.slice(0, 7) ? " <span class=\"rs-sub\">(en curso)</span>" : ""}</td><td class="n mono">${_r0(v)}</td><td class="n mono">${_r0(g)}</td><td class="n mono">${_r0(v / x.length)}</td><td class="n">${x.reduce((a, d) => a + d.s, 0)}</td></tr>`; }).join("")}</table></div>`;
  cont.innerHTML = html;
  try {
    if (_anChart) _anChart.destroy();
    _anChart = new Chart($("anChartDow"), { type: "bar", data: { labels: ["L", "M", "X", "J", "V", "S", "D"], datasets: [{ data: [1, 2, 3, 4, 5, 6, 7].map(i => Math.round(porDow[i].v)), backgroundColor: [1, 2, 3, 4, 5, 6, 7].map(i => i === ordenDow[0] ? "#16a34a" : i === ordenDow[6] ? "#dc2626" : "#f59e0b") }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } } });
  } catch (e) { /* sin gráfico */ }
}

// ============================================================
// 🕓 Movimientos (bitácora oimira_caja.historial) — SOLO administradores con el permiso
// "Ver movimientos y restaurar" (caja_movimientos, o el dueño). La base de datos lo exige también (RLS + RPC).
// ============================================================
const HIST_NOMBRE = { dia_cierre: "Cierre", dia_gasto: "Gasto de un cierre", dia_saco: "Sacos de un cierre", forma_pago_extra: "Forma de pago de un cierre",
  caja_retiro: "Retiro", caja_saldo: "Saldo de caja", saco_compra: "Compra de trigo", saco_producto: "Saco (catálogo)", cajera: "Cajera",
  canal_caja: "Canal", categoria_gasto: "Categoría", forma_pago_catalogo: "Forma de pago", saco_peso: "Peso de saco", saco_tipo: "Tipo de saco", admin_unlock_code: "Código de edición" };
const HIST_CAMPO = { pix_rs: "PIX", dinheiro_rs: "Efectivo", ventas_efectivo_rs: "Venta efectivo", debito_rs: "Débito", pago_movil_bs: "Pago Móvil",
  bs_efectivo_bs: "Bs efectivo", usd_usd: "USD", tickets: "Tickets", sacos_trigo: "Sacos", observacoes: "Notas", cajera: "Cajera", monto: "Monto",
  moeda: "Moneda", motivo: "Motivo", destino: "Destino", nota: "Nota", canal: "Canal", fecha: "Fecha", stock_base: "Existencia", stock_min: "Mínimo",
  activo: "Visible", tasa_bs_rs: "Tasa Bs", tasa_usd_rs: "Tasa USD", efectivo_deteriorado_rs: "Deteriorado", nombre: "Nombre", label: "Nombre visible",
  cantidad: "Cantidad", precio_unit: "Precio", costo: "Costo" };
const HIST_HIJOS = ["dia_gasto", "dia_saco", "forma_pago_extra"];
let HIST_LIM = 50;
let PUEDE_MOV = false;
function _histResumen(h) {
  const r = h.despues || h.antes || {};
  if (h.op === "UPDATE" && h.antes && h.despues) {
    const ign = ["updated_at", "transmitted_at", "submitted_at", "device", "stock_ajustado_at", "stock_consumo_incluido", "stock_compras_incluidas"];
    const cambios = Object.keys(h.despues).filter(k => !ign.includes(k) && JSON.stringify(h.antes[k]) !== JSON.stringify(h.despues[k]));
    const cab = r.fecha ? fmtFecha(r.fecha) + " · " : (r.label || r.nombre ? (r.label || r.nombre) + " · " : "");
    if (!cambios.length) return cab + "sin cambios visibles";
    return cab + cambios.slice(0, 4).map(k => `${HIST_CAMPO[k] || k}: ${h.antes[k] ?? "—"} → ${h.despues[k] ?? "—"}`).join(" · ") + (cambios.length > 4 ? " …" : "");
  }
  const partes = [];
  if (r.fecha) partes.push(fmtFecha(r.fecha));
  if (r.monto != null) partes.push(fmtMoeda(r.monto, r.moeda));
  if (r.cantidad != null) partes.push(r.cantidad + " u");
  ["motivo", "descripcion", "nombre", "label", "cajera", "tipo", "canal"].forEach(k => { if (r[k]) partes.push(String(r[k])); });
  return partes.join(" · ");
}
function _histRestaurable(h) {
  if (HIST_HIJOS.includes(h.tabla) || h.tabla === "admin_unlock_code") return false;
  if (h.op === "INSERT" && h.tabla === "dia_cierre") return false;
  return true;
}
async function cargarHistorial(reiniciar) {
  const cont = $("histLista"); if (!cont) return;
  if (!PUEDE_MOV) { cont.innerHTML = ""; return; }
  if (reiniciar) HIST_LIM = 50;
  const f = ($("histFiltro") && $("histFiltro").value) || "";
  const op = ($("histOp") && $("histOp").value) || "";
  let q = sb.from("historial").select("*").order("id", { ascending: false }).limit(HIST_LIM);
  if (f) q = q.in("tabla", f.split(","));
  else q = q.not("tabla", "in", "(" + HIST_HIJOS.join(",") + ")");
  if (op) q = q.eq("op", op);
  cont.innerHTML = '<div class="text-xs text-gray-500 text-center py-4">Cargando movimientos…</div>';
  const { data, error } = await q;
  if (error) { cont.innerHTML = `<div class="rs-card text-xs text-red-700">No se pudo leer: ${escapeHtml(error.message)}</div>`; return; }
  const lista = data || [];
  if (!lista.length) { cont.innerHTML = '<div class="rs-card text-xs text-gray-500 italic">No hay movimientos con este filtro. (Se registran desde el 04/10/2026.)</div>'; $("histMas").classList.add("hidden"); return; }
  const ICO = { INSERT: "🆕", UPDATE: "✏️", DELETE: "🗑" };
  const VERBO = { INSERT: "nuevo", UPDATE: "cambiado", DELETE: "borrado" };
  const COLOR = { INSERT: "border-emerald-200", UPDATE: "border-amber-200", DELETE: "border-red-300 bg-red-50" };
  cont.innerHTML = lista.map(h => {
    const cuando = new Date(h.ts).toLocaleString("es-VE", { timeZone: APP_TZ, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
    const boton = _histRestaurable(h)
      ? `<button type="button" class="hist-rest shrink-0 self-center text-xs font-bold px-3 py-2 rounded-lg bg-emerald-600 text-white" data-id="${h.id}" data-op="${h.op}">↩ Restaurar</button>`
      : `<span class="shrink-0 self-center text-[10px] text-gray-400 w-16 text-center">${HIST_HIJOS.includes(h.tabla) ? "se corrige editando el cierre" : "—"}</span>`;
    return `<div class="flex gap-2 bg-white rounded-xl p-2.5 border-2 ${COLOR[h.op] || "border-gray-200"}">
      <div class="flex-1 min-w-0">
        <div class="text-xs font-bold">${ICO[h.op] || "•"} ${HIST_NOMBRE[h.tabla] || h.tabla} · ${VERBO[h.op] || h.op}</div>
        <div class="text-xs text-gray-700 break-words">${escapeHtml(_histResumen(h))}</div>
        <div class="text-[10px] text-gray-500 mt-0.5">👤 ${escapeHtml(h.usuario || "sistema")} · ${cuando}</div>
      </div>
      ${boton}
    </div>`;
  }).join("");
  $("histMas").classList.toggle("hidden", lista.length < HIST_LIM);
  const QUE = { UPDATE: "Volverá a quedar como estaba ANTES de este cambio.", DELETE: "Se volverá a crear tal como estaba antes de borrarlo.", INSERT: "Se deshará (se quita lo que se creó)." };
  cont.querySelectorAll(".hist-rest").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("¿Restaurar este movimiento?\n\n" + (QUE[b.dataset.op] || "") + "\n\nEsto también queda registrado en Movimientos.")) return;
    b.disabled = true; b.textContent = "…";
    const { data: msg, error: e2 } = await sbPagos.rpc("caja_historial_restaurar", { p_historial_id: Number(b.dataset.id) });
    if (e2) { toast("No se pudo restaurar: " + e2.message, 5000); b.disabled = false; b.textContent = "↩ Restaurar"; return; }
    toast("✅ " + (msg || "Restaurado"));
    await reload();
    cargarHistorial(true);
  }));
}
function wireHistorial() {
  ["histFiltro", "histOp"].forEach(id => { const f = $(id); if (f) f.addEventListener("change", () => cargarHistorial(true)); });
  const m = $("histMas"); if (m) m.addEventListener("click", () => { HIST_LIM += 50; cargarHistorial(false); });
  const ab = $("movAbrir"); if (ab) ab.addEventListener("click", () => mostrarTab("movimientos"));
  const vo = $("movVolver"); if (vo) vo.addEventListener("click", () => mostrarTab("ajustes"));
}

// ============================================================
// 🔑 Generador de códigos de edición (para desbloquear PWA caja)
// ============================================================
function randomCode6() {
  // 6 dígitos sin ceros a la izquierda
  return String(100000 + Math.floor(Math.random() * 900000));
}

function openCodigoModal() {
  $("cg_fecha").value = "";
  $("cg_descripcion").value = "";
  $("cg_formView").classList.remove("hidden");
  $("cg_resultView").classList.add("hidden");
  renderCodigosRecientes();
  openModal("modalCodigo");
}

async function generarCodigo() {
  const fecha = $("cg_fecha").value || null;
  const descripcion = $("cg_descripcion").value.trim() || null;
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // +30 min

  // Intentar hasta 5 veces por colisión (muy improbable)
  for (let i = 0; i < 5; i++) {
    const code = randomCode6();
    const { data, error } = await sb.from("admin_unlock_code").insert({
      code,
      fecha_objetivo: fecha,
      descripcion,
      expires_at: expiresAt.toISOString(),
    }).select().single();

    if (!error) {
      $("cg_codigoDisplay").textContent = code;
      const hh = String(expiresAt.getHours()).padStart(2, "0");
      const mm = String(expiresAt.getMinutes()).padStart(2, "0");
      $("cg_expiraLabel").textContent = hh + ":" + mm;
      $("cg_formView").classList.add("hidden");
      $("cg_resultView").classList.remove("hidden");
      renderCodigosRecientes();
      return;
    }
    // si fue colisión de unique, reintenta; si no, aborta
    if (!String(error.message).includes("duplicate")) {
      toast("Error: " + error.message);
      return;
    }
  }
  toast("No se pudo generar código, probá de nuevo");
}

async function renderCodigosRecientes() {
  const { data, error } = await sb.from("admin_unlock_code")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);
  const cont = $("cg_lista");
  if (error || !data || !data.length) {
    cont.innerHTML = `<div class="text-[11px] text-gray-500 italic">Sin códigos generados</div>`;
    return;
  }
  const now = Date.now();
  cont.innerHTML = data.map(c => {
    const expired = new Date(c.expires_at).getTime() < now;
    const status = c.used_at
      ? `<span class="pill" style="background:#d1fae5;color:#065f46">✓ Usado</span>`
      : expired
      ? `<span class="pill" style="background:#fee2e2;color:#991b1b">Expirado</span>`
      : `<span class="pill" style="background:#dbeafe;color:#1e40af">Activo</span>`;
    return `
      <div class="flex items-center justify-between p-2 bg-gray-50 border border-gray-200 rounded text-xs">
        <div class="flex-1 min-w-0">
          <div class="mono font-bold text-gray-800">${escapeHtml(c.code)}</div>
          <div class="text-[10px] text-gray-500 truncate">
            ${c.fecha_objetivo ? fmtFecha(c.fecha_objetivo) + " · " : "cualquier día · "}
            ${escapeHtml(c.descripcion || "(sin nota)")}
          </div>
          ${c.used_at ? `<div class="text-[10px] text-green-700">Usado por ${escapeHtml(c.used_by || "?")} el ${new Date(c.used_at).toLocaleString("es-AR")}</div>` : ""}
        </div>
        <div class="ml-2">${status}</div>
      </div>
    `;
  }).join("");
}

async function copiarCodigo() {
  const code = $("cg_codigoDisplay").textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast("Código copiado");
  } catch { toast("Copiá manualmente: " + code); }
}

async function compartirCodigo() {
  const code = $("cg_codigoDisplay").textContent;
  const desc = $("cg_descripcion").value || "";
  const text = `🔑 Código OiMira Caja: ${code}\n${desc}\nVálido 30 min, un solo uso.`;
  if (navigator.share) {
    try { await navigator.share({ title: "Código OiMira", text }); }
    catch { /* cancelado */ }
  } else {
    await navigator.clipboard?.writeText(text);
    toast("Texto copiado para compartir");
  }
}

function wireCodigoListeners() {
  $("codigoBtn")?.addEventListener("click", openCodigoModal);
  $("cg_generar")?.addEventListener("click", generarCodigo);
  $("cg_copiar")?.addEventListener("click", copiarCodigo);
  $("cg_compartir")?.addEventListener("click", compartirCodigo);
  $("cg_nuevo")?.addEventListener("click", () => {
    $("cg_formView").classList.remove("hidden");
    $("cg_resultView").classList.add("hidden");
  });
}

// ============================================================
// Service worker y actualizaciones
// sw.js debe cambiar en CADA despliegue (su SW_VERSION nombra la cache);
// si no cambia, el navegador no detecta version nueva y el panel queda pegado.
// ============================================================

/* ===== Interconexion con OiMira Pagos ===== */
let VINCULOS_PAGOS = [];
// 2026-09-29: Pagos se lee con el token de la sesión del admin (RPC pagos_datos); sin token = volver a entrar con el PIN
async function pagosDatos() {
  const t = localStorage.getItem("oimira_admin_token");
  if (!t) return null;
  const { data, error } = await sbPagos.rpc("pagos_datos", { p_token: t });
  if (error) { if (/Sesión vencida|Sin permiso/i.test(error.message || "")) localStorage.removeItem("oimira_admin_token"); throw error; }
  return data;
}
async function cargarVinculosPagos(moeda) {
  const sel = $("rt_vinculo");
  if (!sel) return;
  sel.innerHTML = '<option value="">— No vincular —</option>';
  VINCULOS_PAGOS = [];
  try {
    const D = await pagosDatos();
    if (!D) { sel.innerHTML = '<option value="">— Para vincular con Pagos, sal y vuelve a entrar con tu PIN —</option>'; return; }
    const rf = { data: (D.facturas || []).filter(f => f.estado === "pendiente" && f.moeda === moeda && Number(f.saldo) > 0) };
    const rc = { data: (D.creditos || []).filter(c => !c.cerrado && c.moeda === moeda && Number(c.saldo) > 0) };
    (rf.data || []).forEach(f => {
      VINCULOS_PAGOS.push({ key: "f:" + f.id, saldo: f.saldo, nombre: f.titulo });
      sel.insertAdjacentHTML("beforeend", `<option value="f:${f.id}">🧾 Factura: ${escapeHtml(f.titulo)}${f.proveedor ? " · " + escapeHtml(f.proveedor) : ""} — saldo ${fmtMoeda(f.saldo, moeda)}</option>`);
    });
    (rc.data || []).forEach(c => {
      VINCULOS_PAGOS.push({ key: "c:" + c.id, saldo: c.saldo, nombre: c.proveedor });
      sel.insertAdjacentHTML("beforeend", `<option value="c:${c.id}">🤝 Crédito: ${escapeHtml(c.proveedor)} — saldo ${fmtMoeda(c.saldo, moeda)}</option>`);
    });
  } catch (e) { console.error("vinculos pagos", e); }
}

// Aviso de pagos por vencer (1 dia de antelacion) al abrir el panel
(async function avisoPagosPanel() {
  try {
    function hoyVE(){ return new Date(Date.now() - 14400000).toISOString().slice(0, 10); }
    const hoy = hoyVE();
    const man = (function(){ const d = new Date(hoy + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
    const D = await pagosDatos();
    const rows = D ? (D.facturas || []).filter(p => p.estado === "pendiente" && p.vence <= man) : null;
    if (!rows || !rows.length) return;
    const venc = rows.filter(p => p.vence < hoy).length, dHoy = rows.filter(p => p.vence === hoy).length, dMan = rows.filter(p => p.vence === man).length;
    const partes = [];
    if (venc) partes.push("⛔ " + venc + " vencido" + (venc > 1 ? "s" : ""));
    if (dHoy) partes.push("📌 " + dHoy + " HOY");
    if (dMan) partes.push("⏰ " + dMan + " mañana");
    const grave = venc || dHoy;
    const det = rows.slice(0, 3).map(p => p.titulo + " (" + p.moeda + " " + Number(p.saldo).toFixed(2) + ")").join(" · ");
    document.body.insertAdjacentHTML("afterbegin",
      `<div onclick="window.open('https://invpolley.github.io/oimira-pagos/','_blank')" style="cursor:pointer;margin:8px 10px;padding:10px 14px;border-radius:12px;font-size:13px;border:1px solid ${grave ? "#f87171" : "#fbbf24"};background:${grave ? "#fef2f2" : "#fffbeb"};color:${grave ? "#991b1b" : "#92400e"}">` +
      `<b>💳 Pagos por atender:</b> ${partes.join(" · ")}<br><span style="opacity:.8;font-size:11.5px">${det}${rows.length > 3 ? " · +" + (rows.length - 3) + " más" : ""} — toca para abrir OiMira Pagos</span></div>`);
  } catch (e) { /* sin conexion: no molestar */ }
})();

const APP_BUILD = "2026-10-05.2";

if ("serviceWorker" in navigator) {
  let recargando = false;
  const recargar = () => { if (!recargando) { recargando = true; window.location.reload(); } };

  function avisarNuevaVersion(reg) {
    if (document.visibilityState !== "visible") return recargar();
    if (document.getElementById("swUpdateBar")) return;
    const bar = document.createElement("button");
    bar.id = "swUpdateBar";
    bar.textContent = "🔄 Nueva versión lista — tocá para actualizar";
    bar.setAttribute("style",
      "position:fixed;left:0;right:0;bottom:0;z-index:99998;border:0;padding:14px;" +
      "background:#16a34a;color:#fff;font-weight:700;font-size:14px;box-shadow:0 -2px 12px rgba(0,0,0,.25)");
    bar.onclick = () => { if (reg && reg.waiting) reg.waiting.postMessage("SKIP_WAITING"); recargar(); };
    document.body.appendChild(bar);
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(reg => {
      const buscar = () => { try { reg.update(); } catch {} };
      buscar();
      setInterval(buscar, 5 * 60 * 1000);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") buscar(); });

      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if ((nw.state === "installed" || nw.state === "activated") && navigator.serviceWorker.controller) {
            avisarNuevaVersion(reg);
          }
        });
      });

      navigator.serviceWorker.addEventListener("message", (ev) => {
        const v = ev.data && ev.data.swVersion;
        if (v && v !== APP_BUILD) {
          const e = document.getElementById("appVersion");
          if (e) e.textContent = `📊 Admin · v${APP_BUILD} ⚠ sw ${v}`;
          buscar();
        }
      });
      if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage("VERSION");
    }).catch(err => console.warn("SW admin fail:", err));

    navigator.serviceWorker.addEventListener("controllerchange", recargar);
  });
}

// ============================================================
// 📥 Instalación PWA (celular + PC)
// ============================================================
let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true; // iOS Safari
}

function detectPlatform() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

function showInstallButtons() {
  // Si ya está instalada, no mostrar nada
  if (isStandalone()) {
    $("installBtn")?.classList.add("hidden");
    $("installBtnGate")?.classList.add("hidden");
    return;
  }
  // Mostrar botones (tanto en header como en pinGate)
  $("installBtn")?.classList.remove("hidden");
  $("installBtnGate")?.classList.remove("hidden");
}

function openInstallModal() {
  const platform = detectPlatform();
  // Ocultar todas las instrucciones
  ["installIos","installAndroid","installDesktop","installAlready"].forEach(id => $(id).classList.add("hidden"));

  if (isStandalone()) {
    $("installAlready").classList.remove("hidden");
    $("installNowBtn").classList.add("hidden");
  } else if (platform === "ios") {
    $("installIos").classList.remove("hidden");
    $("installNowBtn").classList.add("hidden"); // iOS no soporta prompt nativo
  } else if (platform === "android") {
    $("installAndroid").classList.remove("hidden");
    // Si el browser ofreció prompt, mostrar botón para dispararlo
    if (deferredInstallPrompt) {
      $("installNowBtn").classList.remove("hidden");
    } else {
      $("installNowBtn").classList.add("hidden");
    }
  } else {
    $("installDesktop").classList.remove("hidden");
    if (deferredInstallPrompt) {
      $("installNowBtn").classList.remove("hidden");
    } else {
      $("installNowBtn").classList.add("hidden");
    }
  }
  openModal("modalInstall");
}

async function triggerNativeInstall() {
  if (!deferredInstallPrompt) { toast("El navegador no ofreció instalación aún"); return; }
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === "accepted") {
    toast("App instalada 🎉");
    closeModal("modalInstall");
    showInstallButtons();
  } else {
    toast("Instalación cancelada");
  }
  deferredInstallPrompt = null;
}

// Capturar el prompt del browser cuando esté listo
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallButtons();
});

// Cuando ya se instala, ocultamos los botones
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  showInstallButtons();
  toast("¡App instalada en tu dispositivo!");
});

// Wire listeners de los botones
function wireInstallListeners() {
  $("installBtn")?.addEventListener("click", openInstallModal);
  $("installBtnGate")?.addEventListener("click", openInstallModal);
  $("installNowBtn")?.addEventListener("click", triggerNativeInstall);
  // Decidir visibilidad al cargar
  showInstallButtons();
}

// Llamar inmediato (no espera al PIN) para que el botón del gate aparezca
document.addEventListener("DOMContentLoaded", wireInstallListeners);
if (document.readyState === "interactive" || document.readyState === "complete") {
  wireInstallListeners();
}

// ============================================================
// 🔢 Autoselect universal en inputs numéricos (fix del "0" que no se borra)
// ============================================================
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (el.tagName === "INPUT" && (el.type === "number" || el.type === "tel") && !el.readOnly) {
    // Seleccionar todo el contenido al enfocar (funciona bien en mobile)
    setTimeout(() => { try { el.select(); } catch {} }, 0);
  }
});

// ============================================================
// ============================================================
//   💰 MÓDULO SALDOS DE CAJA + RETIROS
// ============================================================
// ============================================================

async function fetchCajaSaldos(desde, hasta) {
  const { data, error } = await sb
    .from("caja_saldo_resumen")
    .select("*")
    .gte("fecha", desde)
    .lte("fecha", hasta)
    .order("fecha", { ascending: false });
  if (error) { console.error(error); toast("Error cargando caja: " + error.message); return []; }
  return data || [];
}

async function fetchCajaRetiros(desde, hasta) {
  const { data, error } = await sb
    .from("caja_retiro")
    .select("*")
    .gte("fecha", desde)
    .lte("fecha", hasta)
    .order("created_at", { ascending: false });
  if (error) { console.error(error); return []; }
  return data || [];
}

async function fetchUltimoSaldo(beforeFecha) {
  // Trae el último cierre ANTES de la fecha para autocompletar "saldos ant."
  const { data, error } = await sb
    .from("caja_saldo_resumen")
    .select("*")
    .lt("fecha", beforeFecha)
    .order("fecha", { ascending: false })
    .limit(1);
  if (error || !data || !data.length) return null;
  return data[0];
}

// ------------- Render cards (7 canales) -------------
function renderCajaSaldos() {
  // Aplicar nombres/visibilidad de canales (renombrados desde el panel)
  aplicarLabelsCanales();
  const latest = state.cajaSaldos[0];
  const label = $("cajaFechaLabel");

  const setEmpty = () => {
    $("cajaEfectivo").textContent     = fmtR(0);
    $("cajaPix").textContent          = fmtR(0);
    $("cajaPuntoBr").textContent      = fmtR(0);
    $("cajaPagoMovil").textContent    = fmtB(0);
    $("cajaBanescoPos").textContent   = fmtB(0);
    $("cajaBsEfectivo").textContent   = fmtB(0);
    $("cajaUsd").textContent          = fmtU(0);
    $("cajaTotalEfectivo").textContent = fmtR(0);
    $("cajaRecargas").textContent     = "—";
    ["cajaEfectivoDetail","cajaPixDetail","cajaPuntoBrDetail","cajaPagoMovilDetail","cajaBanescoPosDetail","cajaBsEfectivoDetail","cajaUsdDetail"]
      .forEach(id => { const el = $(id); if (el) el.textContent = ""; });
  };

  if (!latest) {
    label.textContent = "Sin cierres de caja en este rango";
    setEmpty();
    return;
  }
  label.textContent = `Último cierre: ${fmtFecha(latest.fecha)} · Polley`;

  // Efectivo R$
  $("cajaEfectivo").textContent = fmtR(latest.efectivo_saldo_total);
  $("cajaEfectivoDetail").textContent = `ant ${fmtN(latest.efectivo_saldo_ant)} + hoy ${fmtN(latest.efectivo_hoy)}${Number(latest.gastos_efectivo_hoy) > 0 ? " − gastos " + fmtN(latest.gastos_efectivo_hoy) : ""}`;

  // PIX R$
  $("cajaPix").textContent = fmtR(latest.pix_saldo_total);
  $("cajaPixDetail").textContent = `ant ${fmtN(latest.pix_saldo_ant)} + hoy ${fmtN(latest.pix_hoy)}`;

  // Punto Br R$
  $("cajaPuntoBr").textContent = fmtR(latest.punto_br_saldo_total);
  $("cajaPuntoBrDetail").textContent = `ant ${fmtN(latest.punto_br_saldo_ant)} + hoy ${fmtN(latest.punto_br_hoy)}`;

  // 🏦 Banesco Bs UNIFICADO (01/10/2026, Polley): Pago Móvil y Banesco POS caen en la MISMA cuenta bancaria.
  // Saldo = suma de las dos columnas; Pago Móvil y POS del día quedan solo como referencia.
  $("cajaPagoMovil").textContent = fmtB(bancoBs(latest));
  $("cajaPagoMovilDetail").textContent = `ant ${fmtN(Number(latest.pago_movil_saldo_ant || 0) + Number(latest.banesco_pos_saldo_ant || 0))} + hoy: Pago Móvil ${fmtN(latest.pago_movil_hoy)} · POS ${fmtN(latest.banesco_pos_hoy)}`;
  $("cajaBanescoPos").textContent = fmtB(latest.banesco_pos_saldo_total);
  $("cajaBanescoPosDetail").textContent = "";

  // Bs efectivo
  $("cajaBsEfectivo").textContent = fmtB(latest.bs_efectivo_saldo_total);
  $("cajaBsEfectivoDetail").textContent = `ant ${fmtN(latest.bs_efectivo_saldo_ant)} + hoy ${fmtN(latest.bs_efectivo_hoy)}`;

  // USD físico
  $("cajaUsd").textContent = fmtU(latest.usd_saldo_total);
  $("cajaUsdDetail").textContent = `ant ${fmtN(latest.usd_saldo_ant)} + hoy ${fmtN(latest.usd_hoy)}`;

  // Total efectivo R$ (la caja física)
  $("cajaTotalEfectivo").textContent = fmtR(latest.efectivo_saldo_total);
  $("cajaRecargas").textContent = Number(latest.transf_recarga || 0) > 0
    ? fmtMoeda(latest.transf_recarga, latest.transf_recarga_moeda || "R$")
    : "—";
}

// 2026-10-05 (Polley): retiros "A + C" — por día (compacto) o por tipo (bloques que se abren),
// totales por moneda, etiqueta solo si no es efectivo R$, y borrar desde el detalle (no en cada fila).
const RET_VISTA_KEY = "caja_admin_retiros_vista_v1";
function retTotales(lista) {
  // efectivo se suma por moneda; los demás canales (PIX, punto, etc.) aparte, con su nombre
  const t = {};
  lista.forEach(r => {
    const m = r.moeda || "R$", efe = r.canal === "Efectivo";
    const k = efe ? "E|" + m : r.canal + "|" + m;
    (t[k] = t[k] || { m, c: efe ? "" : canalLabel(r.canal), v: 0 }).v += Number(r.monto || 0);
  });
  // 2026-10-05: cada canal es una "pastilla" corta (antes era una línea larguísima que se montaba)
  const chips = Object.values(t).sort((a, b) => (a.c ? 1 : 0) - (b.c ? 1 : 0)).map(x =>
    `<span class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ${x.c ? "bg-white border border-rose-200" : "bg-rose-600 text-white"}">` +
    `<span class="text-[10px] ${x.c ? "text-gray-500" : "text-rose-100"}">${x.c ? escapeHtml(retCanalCorto(x.c)) : "Efectivo"}</span>` +
    `<span class="mono font-bold text-[11.5px] ${x.c ? "text-rose-700" : ""}">−${fmtMoeda(x.v, x.m)}</span></span>`);
  return `<div class="flex flex-wrap gap-1">${chips.join("")}</div>`;
}
function retCanalCorto(label) {
  return String(label).replace(/\s*\(.*?\)\s*/g, " ").replace(/cuenta corriente/i, "").replace(/\s+/g, " ").trim();
}
function retFila(r, conFecha) {
  const pill = (r.canal === "Efectivo" && (r.moeda || "R$") === "R$") ? "" :
    `<span class="pill pill-gas" style="font-size:10px">${canalIcon(r.canal)} ${escapeHtml(retCanalCorto(canalLabel(r.canal)))}</span> `;
  if (conFecha) { // vista por tipo: el motivo ya está en el encabezado del grupo
    const titulo = r.destino || r.nota || r.motivo || "Sin detalle";
    const sub = [fmtFecha(r.fecha), r.destino && r.nota ? r.nota : ""].filter(Boolean).map(escapeHtml).join(" · ");
    return retFilaHtml(r, pill + escapeHtml(titulo), sub);
  }
  const sub = [r.destino ? escapeHtml(r.destino) : "", r.nota ? escapeHtml(r.nota) : ""].filter(Boolean).join(" · ");
  return retFilaHtml(r, pill + escapeHtml(r.motivo || "Sin motivo"), sub);
}
function retFilaHtml(r, titulo, sub) {
  return `<div class="ret-fila border-b border-rose-100 last:border-0" data-id="${r.id}">
    <button type="button" class="ret-abrir w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left">
      <div class="min-w-0"><div class="text-[13px] font-semibold text-rose-900 truncate">${titulo}</div>
        ${sub ? `<div class="text-[11px] text-gray-600 truncate">${sub}</div>` : ""}</div>
      <div class="mono font-bold text-rose-700 whitespace-nowrap text-[13px]">−${fmtMoeda(r.monto, r.moeda)}</div>
    </button>
    <div class="ret-det hidden px-2 pb-2 text-[11px] text-gray-700">
      <div>${fmtFecha(r.fecha)} · ${canalIcon(r.canal)} ${escapeHtml(canalLabel(r.canal))}${r.destino ? " · → " + escapeHtml(r.destino) : ""}</div>
      ${r.nota ? `<div>${escapeHtml(r.nota)}</div>` : ""}
      <button type="button" class="retiro-del mt-1 text-red-600 underline" data-id="${r.id}">🗑 Eliminar este retiro</button>
    </div></div>`;
}
function renderCajaRetiros() {
  const cont = $("cajaRetirosList");
  const lista = state.cajaRetiros || [];
  if (!lista.length) {
    cont.innerHTML = `<div class="text-xs text-gray-500 italic">Sin retiros en el período</div>`;
    return;
  }
  let vista = "dia"; try { vista = localStorage.getItem(RET_VISTA_KEY) || "dia"; } catch (e) {}
  const btn = (v, l) => `<button type="button" class="ret-vista px-2 py-0.5 rounded-full border text-[11px] ${vista === v ? "bg-amber-100 border-amber-400 text-amber-900 font-semibold" : "bg-white border-gray-300 text-gray-600"}" data-v="${v}">${l}</button>`;
  let html = `<div class="flex gap-1 mb-1">${btn("dia", "📅 Por día")}${btn("tipo", "🏷 Por tipo")}</div>
    <div class="bg-white border border-rose-200 rounded-lg px-2 py-1.5 mb-1">
      <div class="text-[11px] text-gray-600 mb-1">Total del período · ${lista.length} retiro(s)</div>${retTotales(lista)}</div>`;
  if (vista === "tipo") {
    const g = {};
    lista.forEach(r => { const k = r.motivo || "Sin motivo"; (g[k] = g[k] || []).push(r); });
    const peso = (arr) => arr.reduce((s, r) => s + Number(r.monto || 0) * ((r.moeda || "R$") === "Bs" ? 0.001 : (r.moeda === "USD" ? 5 : 1)), 0);
    html += Object.entries(g).sort((a, b) => peso(b[1]) - peso(a[1])).map(([k, arr]) => `
      <details class="bg-rose-50 border border-rose-200 rounded-lg">
        <summary class="px-2 py-1.5 cursor-pointer text-[13px]">
          <span class="font-semibold text-rose-900">${escapeHtml(k)} · ${arr.length}</span>
          <div class="mt-1">${retTotales(arr)}</div>
        </summary>
        <div class="bg-white rounded-b-lg">${arr.map(r => retFila(r, true)).join("")}</div>
      </details>`).join("");
  } else {
    const d = {};
    lista.forEach(r => { (d[r.fecha] = d[r.fecha] || []).push(r); });
    html += Object.keys(d).sort((a, b) => String(b).localeCompare(String(a))).map(f => `
      <div class="bg-rose-50 border border-rose-200 rounded-lg overflow-hidden">
        <div class="px-2 py-1 bg-rose-100 text-[12px] font-semibold text-rose-900">
          <div class="mb-1">${fmtFecha(f)} · ${d[f].length} retiro(s)</div>${retTotales(d[f])}</div>
        <div class="bg-white">${d[f].map(r => retFila(r, false)).join("")}</div>
      </div>`).join("");
  }
  cont.innerHTML = html;
  cont.querySelectorAll(".ret-vista").forEach(b => b.addEventListener("click", () => {
    try { localStorage.setItem(RET_VISTA_KEY, b.dataset.v); } catch (e) {}
    renderCajaRetiros();
  }));
  cont.querySelectorAll(".ret-abrir").forEach(b => b.addEventListener("click", () => {
    b.parentElement.querySelector(".ret-det").classList.toggle("hidden");
  }));
  cont.querySelectorAll(".retiro-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este retiro?\n\nSi fue un error, se puede recuperar en ⚙️ Ajustes → 🕓 Historial.")) return;
      const { error } = await sb.from("caja_retiro").delete().eq("id", btn.dataset.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Retiro eliminado (recuperable en 🕓 Historial)");
      reload();
    });
  });
}
function renderCajaRetirosViejo() {
  const cont = $("cajaRetirosList");
  if (!state.cajaRetiros.length) {
    cont.innerHTML = `<div class="text-xs text-gray-500 italic">Sin retiros en el período</div>`;
    return;
  }
  cont.innerHTML = state.cajaRetiros.map(r => `
    <div class="flex items-center justify-between bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-sm">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="pill pill-gas">${canalIcon(r.canal)} ${escapeHtml(canalLabel(r.canal))}</span>
          <span class="font-semibold text-rose-900 truncate">${escapeHtml(r.motivo || "Sin motivo")}</span>
        </div>
        <div class="text-[11px] text-gray-600 mt-0.5">
          ${fmtFecha(r.fecha)}${r.destino ? " · → " + escapeHtml(r.destino) : ""}${r.nota ? " · " + escapeHtml(r.nota) : ""}
        </div>
      </div>
      <div class="mono font-bold text-rose-700 whitespace-nowrap ml-2">
        − ${fmtMoeda(r.monto, r.moeda)}
      </div>
      <button class="retiro-del text-gray-400 hover:text-red-600 ml-2 text-lg" data-id="${r.id}" title="Eliminar">🗑</button>
    </div>
  `).join("");

  // Wire delete
  cont.querySelectorAll(".retiro-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este retiro?\n\nSi fue un error, se puede recuperar en ⚙️ Ajustes → 🕓 Historial.")) return;
      const { error } = await sb.from("caja_retiro").delete().eq("id", btn.dataset.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Retiro eliminado (recuperable en 🕓 Historial)");
      reload();
    });
  });
}

function canalLabel(c) {
  return canalDef(c).label || c;
}
function canalIcon(c) {
  return canalDef(c).icon || "💰";
}

// ============================================================
// 📈 Evolución por canal (4 sparklines)
// ============================================================
function renderCajaEvolucion() {
  const data = [...state.cajaSaldos].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const empty = data.length === 0;
  $("evolEmpty").classList.toggle("hidden", !empty);

  const series = {
    efectivo: {
      canvas: "chartEfectivo", color: "#16a34a", bg: "rgba(22,163,74,0.15)",
      fmt: fmtR,
      totalField: "efectivo_saldo_total", hoyField: "efectivo_hoy",
      lastEl: "evolEfectivoLast", deltaEl: "evolEfectivoDelta", rangeEl: "evolEfectivoRange",
    },
    punto: {
      canvas: "chartPunto", color: "#3b82f6", bg: "rgba(59,130,246,0.15)",
      fmt: fmtB,
      totalField: "punto_saldo_total", hoyField: "punto_hoy",
      lastEl: "evolPuntoLast", deltaEl: "evolPuntoDelta", rangeEl: "evolPuntoRange",
    },
    puntoBr: {
      canvas: "chartPuntoBr", color: "#d97706", bg: "rgba(217,119,6,0.15)",
      fmt: fmtR,
      totalField: "punto_br_saldo_total", hoyField: "punto_br_hoy",
      lastEl: "evolPuntoBrLast", deltaEl: "evolPuntoBrDelta", rangeEl: "evolPuntoBrRange",
    },
    usd: {
      canvas: "chartUsd", color: "#059669", bg: "rgba(5,150,105,0.15)",
      fmt: fmtU,
      totalField: "usd_saldo_total", hoyField: "usd_hoy",
      lastEl: "evolUsdLast", deltaEl: "evolUsdDelta", rangeEl: "evolUsdRange",
    },
  };

  for (const [key, cfg] of Object.entries(series)) {
    drawSparkline(key, cfg, data);
  }
}

function drawSparkline(key, cfg, data) {
  const labels = data.map(d => fmtFecha(d.fecha));
  const field = state.evolMetric === "hoy" ? cfg.hoyField : cfg.totalField;
  const values = data.map(d => Number(d[field] || 0));

  // Último valor + delta vs primero
  const last = values.length ? values[values.length - 1] : 0;
  const first = values.length ? values[0] : 0;
  const delta = last - first;
  $(cfg.lastEl).textContent = cfg.fmt(last);

  const deltaEl = $(cfg.deltaEl);
  if (values.length >= 2) {
    const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";
    const color = delta > 0 ? "text-green-600" : delta < 0 ? "text-red-600" : "text-gray-500";
    deltaEl.className = "text-[10px] " + color + " font-semibold";
    deltaEl.textContent = `${arrow} ${cfg.fmt(Math.abs(delta))}`;
  } else {
    deltaEl.textContent = "\u00a0"; // nbsp
    deltaEl.className = "text-[10px]";
  }

  $(cfg.rangeEl).textContent = data.length
    ? `${fmtFecha(data[0].fecha)} → ${fmtFecha(data[data.length-1].fecha)} · ${data.length} día${data.length === 1 ? "" : "s"}`
    : "—";

  // Chart
  const ctx = $(cfg.canvas).getContext("2d");
  if (state.cajaCharts[key]) state.cajaCharts[key].destroy();

  // Si no hay datos, dibujamos un placeholder vacío
  if (!values.length) {
    state.cajaCharts[key] = new Chart(ctx, {
      type: "line",
      data: { labels: [], datasets: [] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });
    return;
  }

  state.cajaCharts[key] = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: cfg.color,
        backgroundColor: cfg.bg,
        borderWidth: 2,
        tension: 0.3,
        fill: true,
        pointRadius: values.length <= 7 ? 3 : 2,
        pointHoverRadius: 5,
        pointBackgroundColor: cfg.color,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            label: (ctx) => cfg.fmt(ctx.parsed.y),
          },
        },
      },
      scales: {
        y: {
          beginAtZero: state.evolMetric === "hoy",
          ticks: { font: { size: 9 }, maxTicksLimit: 4 },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
        x: {
          ticks: { font: { size: 9 }, maxTicksLimit: 6, autoSkip: true },
          grid: { display: false },
        },
      },
      interaction: { mode: "nearest", intersect: false },
    },
  });
}

// ------------- Modal helpers -------------
// Los modales registran una entrada en el historial para que el gesto de
// "volver" del celular cierre el modal en vez de sacarte de la app al hub.
const MODALES_ABIERTOS = [];
let _ignorarPop = 0;

function openModal(id) {
  const el = $(id); if (!el) return;
  el.classList.remove("hidden");
  if (MODALES_ABIERTOS.includes(id)) return;
  MODALES_ABIERTOS.push(id);
  try { history.pushState({ modalOiMira: id }, ""); } catch {}
}

function closeModal(id) {
  const el = $(id); if (el) el.classList.add("hidden");
  const i = MODALES_ABIERTOS.lastIndexOf(id);
  if (i === -1) return;
  MODALES_ABIERTOS.splice(i, 1);
  // Consumir la entrada que agregamos al abrir, sin que se cierre otro modal.
  _ignorarPop++;
  try { history.back(); } catch { _ignorarPop--; }
}

window.addEventListener("popstate", () => {
  if (_ignorarPop > 0) { _ignorarPop--; return; }
  const id = MODALES_ABIERTOS.pop();
  if (id) { const el = $(id); if (el) el.classList.add("hidden"); }
});

function wireModalClose() {
  document.querySelectorAll(".close-modal").forEach(btn => {
    btn.addEventListener("click", () => closeModal(btn.dataset.modal));
  });
  // click fuera del contenido cierra
  ["modalCierreCaja", "modalRetiro", "modalAlertaStock"].forEach(id => {
    $(id).addEventListener("click", (e) => {
      if (e.target.id === id) closeModal(id);
    });
  });
}

// ------------- Cierre de caja (auto-detect nuevo vs editar) -------------
async function openCierreCajaModal() {
  const today = todayISO();
  $("cc_fecha").value = today;
  await cargarCierreCaja(today);
  openModal("modalCierreCaja");
}

async function cargarCierreCaja(fecha) {
  // 1. ¿Existe un cierre para esta fecha?
  const { data: existing, error } = await sb
    .from("caja_saldo")
    .select("*")
    .eq("fecha", fecha)
    .maybeSingle();
  if (error) { toast("Error cargando: " + error.message); return; }

  // 2. Datos de la cajera para esta fecha (auto-fill source)
  const autofill = await fetchDiaCierreAutofill(fecha);
  // 01/10/2026: cierre anterior para avisar si el saldo inicial no coincide (ej. R$ 207 restados dos veces el 30/09)
  CC_PREV = await fetchUltimoSaldo(fecha);

  const banner = $("cc_modeBanner");
  banner.classList.remove("hidden");

  if (existing) {
    // Modo EDITAR — traer todos los valores del registro guardado (7 canales)
    $("cc_efectivo_ant").value      = existing.efectivo_saldo_ant || 0;
    $("cc_efectivo_hoy").value      = existing.efectivo_hoy || 0;
    $("cc_gastos_efectivo").value   = existing.gastos_efectivo_hoy || 0;
    $("cc_pix_ant").value           = existing.pix_saldo_ant || 0;
    $("cc_pix_hoy").value            = existing.pix_hoy || 0;
    $("cc_puntobr_ant").value       = existing.punto_br_saldo_ant || 0;
    $("cc_puntobr_hoy").value        = existing.punto_br_hoy || 0;
    $("cc_pago_movil_ant").value    = existing.pago_movil_saldo_ant || 0;
    $("cc_pago_movil_hoy").value     = existing.pago_movil_hoy || 0;
    $("cc_banesco_pos_ant").value   = existing.banesco_pos_saldo_ant || 0;
    $("cc_banesco_pos_hoy").value    = existing.banesco_pos_hoy || 0;
    $("cc_bs_efectivo_ant").value   = existing.bs_efectivo_saldo_ant || 0;
    $("cc_bs_efectivo_hoy").value    = existing.bs_efectivo_hoy || 0;
    $("cc_usd_ant").value           = existing.usd_saldo_ant || 0;
    $("cc_usd_hoy").value            = existing.usd_hoy || 0;
    $("cc_recarga").value           = existing.transf_recarga || 0;
    $("cc_notas").value             = existing.notas || "";

    banner.className = "mb-3 px-3 py-2 rounded-lg text-xs font-semibold border-2 bg-amber-50 border-amber-300 text-amber-900";
    banner.innerHTML = "✏️ <b>Editando cierre existente</b> del " + fmtFecha(fecha) + " — los cambios sobrescriben el registro guardado.";
  } else {
    // Modo NUEVO — autocompletar saldos_ant del día anterior + hoy desde cajera
    const last = CC_PREV;
    if (last) {
      $("cc_efectivo_ant").value     = last.efectivo_saldo_total || 0;
      $("cc_pix_ant").value          = last.pix_saldo_total || 0;
      $("cc_puntobr_ant").value      = last.punto_br_saldo_total || 0;
      $("cc_pago_movil_ant").value   = last.pago_movil_saldo_total || 0;
      $("cc_banesco_pos_ant").value  = last.banesco_pos_saldo_total || 0;
      $("cc_bs_efectivo_ant").value  = last.bs_efectivo_saldo_total || 0;
      $("cc_usd_ant").value          = last.usd_saldo_total || 0;
    } else {
      ["cc_efectivo_ant","cc_pix_ant","cc_puntobr_ant","cc_pago_movil_ant","cc_banesco_pos_ant","cc_bs_efectivo_ant","cc_usd_ant"]
        .forEach(id => $(id).value = 0);
    }
    // Hoy + recarga + notas reset, y luego auto-fill desde cajera si reportó
    ["cc_efectivo_hoy","cc_gastos_efectivo","cc_pix_hoy","cc_puntobr_hoy","cc_pago_movil_hoy","cc_banesco_pos_hoy","cc_bs_efectivo_hoy","cc_usd_hoy","cc_recarga"]
      .forEach(id => $(id).value = 0);
    $("cc_notas").value = "";

    if (autofill) {
      $("cc_efectivo_hoy").value      = autofill.efectivo_hoy;
      $("cc_gastos_efectivo").value   = autofill.gastos_efectivo_hoy;
      $("cc_pix_hoy").value           = autofill.pix_hoy;
      $("cc_puntobr_hoy").value       = autofill.punto_br_hoy;
      $("cc_pago_movil_hoy").value    = autofill.pago_movil_hoy;
      $("cc_banesco_pos_hoy").value   = autofill.banesco_pos_hoy;
      $("cc_bs_efectivo_hoy").value   = autofill.bs_efectivo_hoy;
      $("cc_usd_hoy").value           = autofill.usd_hoy;
      banner.className = "mb-3 px-3 py-2 rounded-lg text-xs font-semibold border-2 bg-blue-50 border-blue-300 text-blue-900";
      banner.innerHTML = "🆕 <b>Nuevo cierre</b> del " + fmtFecha(fecha) +
        " — saldos anteriores del cierre previo, <b>valores 'hoy' tomados de la cajera</b>" +
        (autofill.cajera ? " (" + escapeHtml(autofill.cajera) + ")" : "") + ".";
    } else {
      banner.className = "mb-3 px-3 py-2 rounded-lg text-xs font-semibold border-2 bg-yellow-50 border-yellow-300 text-yellow-900";
      banner.innerHTML = "🆕 <b>Nuevo cierre</b> del " + fmtFecha(fecha) +
        " — la cajera todavía no transmitió cierre para esta fecha, completá los 'hoy' a mano.";
    }
  }

  // Hints debajo de cada campo "hoy" con lo que reportó la cajera
  if (autofill) renderAutofillHints(autofill);
  else clearAutofillHints();

  recalcCC();
}

// Trae los datos que la cajera reportó para una fecha (dia_cierre + gastos + forma_pago_extra Banesco POS).
// Devuelve null si la cajera todavía no transmitió cierre.
async function fetchDiaCierreAutofill(fecha) {
  const { data: dc } = await sb
    .from("dia_cierre")
    .select("id, cajera, pix_rs, dinheiro_rs, debito_rs, pago_movil_bs, bs_efectivo_bs, usd_usd, transmitted_at")
    .eq("fecha", fecha)
    .maybeSingle();
  if (!dc) return null;

  // Gastos en efectivo R$ del día (lo que pagó la cajera en efectivo)
  const { data: gastos } = await sb
    .from("dia_gasto")
    .select("monto, moeda, forma_pago")
    .eq("dia_cierre_id", dc.id);
  const gastosEfectivoRs = (gastos || [])
    .filter(g => g.moeda === "R$" && (g.forma_pago === "Dinheiro" || g.forma_pago === "Efectivo"))
    .reduce((s, g) => s + Number(g.monto || 0), 0);

  // Banesco POS no tiene columna dedicada; viene en forma_pago_extra
  const { data: extras } = await sb
    .from("forma_pago_extra")
    .select("monto, nombre, moeda")
    .eq("dia_cierre_id", dc.id);
  const banescoPos = (extras || [])
    .filter(e => (e.nombre || "").trim().toLowerCase() === "banesco pos")
    .reduce((s, e) => s + Number(e.monto || 0), 0);

  return {
    cajera: dc.cajera || null,
    transmitted: !!dc.transmitted_at,
    efectivo_hoy:        Number(dc.dinheiro_rs || 0),
    pix_hoy:             Number(dc.pix_rs || 0),
    punto_br_hoy:        Number(dc.debito_rs || 0),
    pago_movil_hoy:      Number(dc.pago_movil_bs || 0),
    bs_efectivo_hoy:     Number(dc.bs_efectivo_bs || 0),
    banesco_pos_hoy:     banescoPos,
    usd_hoy:             Number(dc.usd_usd || 0),
    gastos_efectivo_hoy: gastosEfectivoRs,
  };
}

function renderAutofillHints(af) {
  const who = af.cajera ? "Cajera " + af.cajera : "Cajera";
  const status = af.transmitted ? "" : " (borrador)";
  const hints = {
    cc_efectivo_hint:        `💡 ${who} reportó R$ ${fmtN(af.efectivo_hoy)}${status}`,
    cc_gastos_efectivo_hint: `💡 Gastos efectivo registrados: R$ ${fmtN(af.gastos_efectivo_hoy)}`,
    cc_pix_hint:             `💡 ${who} reportó R$ ${fmtN(af.pix_hoy)}${status}`,
    cc_puntobr_hint:         `💡 ${who} reportó R$ ${fmtN(af.punto_br_hoy)}${status}`,
    cc_pago_movil_hint:      `💡 ${who} reportó Bs ${fmtN(af.pago_movil_hoy)}${status}`,
    cc_banesco_pos_hint:     `💡 ${who} reportó Bs ${fmtN(af.banesco_pos_hoy)}${status}`,
    cc_bs_efectivo_hint:     `💡 ${who} reportó Bs ${fmtN(af.bs_efectivo_hoy)}${status}`,
    cc_usd_hint:             `💡 ${who} reportó US$ ${fmtN(af.usd_hoy)}${status}`,
  };
  Object.entries(hints).forEach(([id, txt]) => {
    const el = $(id);
    if (el) el.textContent = txt;
  });
}

function clearAutofillHints() {
  ["cc_efectivo_hint","cc_gastos_efectivo_hint","cc_pix_hint","cc_puntobr_hint","cc_pago_movil_hint","cc_banesco_pos_hint","cc_bs_efectivo_hint","cc_usd_hint"]
    .forEach(id => { const el = $(id); if (el) el.textContent = ""; });
}

// Botón Re-sync: vuelve a traer los valores de la cajera y los aplica a los campos "hoy"
async function resyncDesdeCajera() {
  const fecha = $("cc_fecha").value;
  if (!fecha) { toast("Elegí una fecha primero"); return; }
  const af = await fetchDiaCierreAutofill(fecha);
  if (!af) { toast("La cajera no transmitió cierre para esta fecha"); return; }
  $("cc_efectivo_hoy").value     = af.efectivo_hoy;
  $("cc_gastos_efectivo").value  = af.gastos_efectivo_hoy;
  $("cc_pix_hoy").value          = af.pix_hoy;
  $("cc_puntobr_hoy").value      = af.punto_br_hoy;
  $("cc_pago_movil_hoy").value   = af.pago_movil_hoy;
  $("cc_banesco_pos_hoy").value  = af.banesco_pos_hoy;
  $("cc_bs_efectivo_hoy").value  = af.bs_efectivo_hoy;
  $("cc_usd_hoy").value          = af.usd_hoy;
  renderAutofillHints(af);
  recalcCC();
  toast("Re-sincronizado desde lo que reportó la cajera");
}

// ⚠️ Aviso: saldo inicial distinto al cierre anterior (01/10/2026, pedido de Polley)
let CC_PREV = null;
const CC_ANT_CAMPOS = [
  ["cc_efectivo_ant", "efectivo_saldo_total", "💵 Efectivo R$", "R$"],
  ["cc_pix_ant", "pix_saldo_total", "PIX", "R$"],
  ["cc_puntobr_ant", "punto_br_saldo_total", "Punto Br", "R$"],
  [["cc_pago_movil_ant", "cc_banesco_pos_ant"], ["pago_movil_saldo_total", "banesco_pos_saldo_total"], "🏦 Banesco Bs (Pago Móvil + POS)", "Bs"],
  ["cc_bs_efectivo_ant", "bs_efectivo_saldo_total", "Bs efectivo", "Bs"],
  ["cc_usd_ant", "usd_saldo_total", "USD", "USD"],
];
function ccDiferenciasAnt() {
  if (!CC_PREV) return [];
  const sum = (ids, src) => [].concat(ids).reduce((t, k) => t + Number(src(k) || 0), 0);
  const out = [];
  CC_ANT_CAMPOS.forEach(([ids, cols, nombre, m]) => {
    const escrito = sum(ids, (id) => $(id) && $(id).value);
    const esperado = sum(cols, (c) => CC_PREV[c]);
    const dif = Math.round((escrito - esperado) * 100) / 100;
    if (Math.abs(dif) > 0.009) out.push({ nombre, m, escrito, esperado, dif });
  });
  return out;
}
function ccAvisoAnt() {
  let el = $("cc_avisoAnt");
  if (!el) {
    const banner = $("cc_modeBanner"); if (!banner) return;
    el = document.createElement("div"); el.id = "cc_avisoAnt";
    banner.insertAdjacentElement("afterend", el);
  }
  const difs = ccDiferenciasAnt();
  if (!difs.length) { el.innerHTML = ""; el.className = ""; return; }
  el.className = "mb-3 px-3 py-2 rounded-lg text-xs border-2 bg-red-50 border-red-400 text-red-900";
  el.innerHTML = `⚠️ <b>El saldo inicial no coincide con el cierre del ${fmtFecha(CC_PREV.fecha)}:</b><br>` +
    difs.map(d => `${escapeHtml(d.nombre)}: escribiste <b>${fmtMoeda(d.escrito, d.m)}</b>, el cierre anterior terminó en <b>${fmtMoeda(d.esperado, d.m)}</b> → diferencia <b>${d.dif > 0 ? "+" : ""}${fmtMoeda(d.dif, d.m)}</b>`).join("<br>") +
    `<br><span class="text-[11px]">Si sacaste o metiste dinero, mejor regístralo como 💸 Retiro o ➕ Ingresar y deja el saldo inicial igual al cierre anterior (si no, se descuenta dos veces).</span>`;
}

function recalcCC() {
  try { ccAvisoAnt(); } catch (e) { /* */ }
  // Efectivo R$ (con gastos)
  const efAnt = Number($("cc_efectivo_ant").value) || 0;
  const efHoy = Number($("cc_efectivo_hoy").value) || 0;
  const gas   = Number($("cc_gastos_efectivo").value) || 0;
  $("cc_efectivo_total").textContent = fmtR(efAnt + efHoy - gas);

  // PIX R$
  const pixAnt = Number($("cc_pix_ant").value) || 0;
  const pixHoy = Number($("cc_pix_hoy").value) || 0;
  $("cc_pix_total").textContent = fmtR(pixAnt + pixHoy);

  // Punto Br R$
  const pbAnt = Number($("cc_puntobr_ant").value) || 0;
  const pbHoy = Number($("cc_puntobr_hoy").value) || 0;
  $("cc_puntobr_total").textContent = fmtR(pbAnt + pbHoy);

  // Pago Móvil Banesco Bs
  const pmAnt = Number($("cc_pago_movil_ant").value) || 0;
  const pmHoy = Number($("cc_pago_movil_hoy").value) || 0;
  $("cc_pago_movil_total").textContent = fmtB(pmAnt + pmHoy);

  // Banesco POS Bs
  const bpAnt = Number($("cc_banesco_pos_ant").value) || 0;
  const bpHoy = Number($("cc_banesco_pos_hoy").value) || 0;
  $("cc_banesco_pos_total").textContent = fmtB(bpAnt + bpHoy);

  // Bs efectivo
  const bsefAnt = Number($("cc_bs_efectivo_ant").value) || 0;
  const bsefHoy = Number($("cc_bs_efectivo_hoy").value) || 0;
  $("cc_bs_efectivo_total").textContent = fmtB(bsefAnt + bsefHoy);

  // USD físico
  const uAnt = Number($("cc_usd_ant").value) || 0;
  const uHoy = Number($("cc_usd_hoy").value) || 0;
  $("cc_usd_total").textContent = fmtU(uAnt + uHoy);
}

async function guardarCierreCaja() {
  // Guard contra doble-click: si ya está procesando, ignorar.
  const btn = $("cc_guardar");
  if (btn.disabled) return;
  btn.disabled = true;
  const _origLabel = btn.textContent;
  btn.textContent = "Guardando…";
  try {
    const payload = {
      fecha: $("cc_fecha").value,
      efectivo_saldo_ant:    Number($("cc_efectivo_ant").value) || 0,
      efectivo_hoy:          Number($("cc_efectivo_hoy").value) || 0,
      gastos_efectivo_hoy:   Number($("cc_gastos_efectivo").value) || 0,
      pix_saldo_ant:         Number($("cc_pix_ant").value) || 0,
      pix_hoy:               Number($("cc_pix_hoy").value) || 0,
      punto_br_saldo_ant:    Number($("cc_puntobr_ant").value) || 0,
      punto_br_hoy:          Number($("cc_puntobr_hoy").value) || 0,
      pago_movil_saldo_ant:  Number($("cc_pago_movil_ant").value) || 0,
      pago_movil_hoy:        Number($("cc_pago_movil_hoy").value) || 0,
      banesco_pos_saldo_ant: Number($("cc_banesco_pos_ant").value) || 0,
      banesco_pos_hoy:       Number($("cc_banesco_pos_hoy").value) || 0,
      bs_efectivo_saldo_ant: Number($("cc_bs_efectivo_ant").value) || 0,
      bs_efectivo_hoy:       Number($("cc_bs_efectivo_hoy").value) || 0,
      usd_saldo_ant:         Number($("cc_usd_ant").value) || 0,
      usd_hoy:               Number($("cc_usd_hoy").value) || 0,
      transf_recarga:        Number($("cc_recarga").value) || 0,
      notas:                 $("cc_notas").value || null,
      cajera: "Polley",
      updated_at: new Date().toISOString(),
    };
    if (!payload.fecha) { toast("Poné una fecha"); return; }
    const difsAnt = ccDiferenciasAnt();
    if (difsAnt.length && !confirm("⚠️ El saldo inicial no coincide con el cierre anterior:\n\n" +
        difsAnt.map(d => `${d.nombre}: diferencia ${d.dif > 0 ? "+" : ""}${fmtMoeda(d.dif, d.m)}`).join("\n") +
        "\n\n¿Guardar igual?")) return;

    const { error } = await sb.from("caja_saldo").upsert(payload, { onConflict: "fecha" });
    if (error) { toast("Error: " + error.message, 4000); return; }

    // Propagar el nuevo saldo total al saldo_ant del día siguiente (si existe).
    // Sin esto, editar un cierre viejo deja el día siguiente con un saldo_ant huérfano.
    const propagado = await propagarSaldoAlDiaSiguiente(payload.fecha);

    toast(propagado
      ? "Cierre guardado · saldo del día siguiente recalculado"
      : "Cierre de caja guardado");
    closeModal("modalCierreCaja");
    reload();
  } finally {
    btn.disabled = false;
    btn.textContent = _origLabel;
  }
}

// Recalcula el saldo_ant del cierre del día SIGUIENTE (si existe), usando
// el saldo_total recién calculado del día que acabamos de guardar.
// Devuelve true si propagó algo, false si no había día siguiente.
async function propagarSaldoAlDiaSiguiente(fecha) {
  // 1. Traer los saldos totales de HOY desde la view (descontados retiros)
  const { data: hoy, error: errHoy } = await sb
    .from("caja_saldo_resumen")
    .select("efectivo_saldo_total, pix_saldo_total, punto_br_saldo_total, pago_movil_saldo_total, banesco_pos_saldo_total, bs_efectivo_saldo_total, usd_saldo_total")
    .eq("fecha", fecha)
    .maybeSingle();
  if (errHoy || !hoy) return false;

  // 2. Cierre del día SIGUIENTE
  const { data: sig, error: errSig } = await sb
    .from("caja_saldo")
    .select("id, fecha")
    .gt("fecha", fecha)
    .order("fecha", { ascending: true })
    .limit(1);
  if (errSig || !sig || !sig.length) return false;

  // 3. Propagar los 7 saldos
  const update = {
    efectivo_saldo_ant:    hoy.efectivo_saldo_total    || 0,
    pix_saldo_ant:         hoy.pix_saldo_total         || 0,
    punto_br_saldo_ant:    hoy.punto_br_saldo_total    || 0,
    pago_movil_saldo_ant:  hoy.pago_movil_saldo_total  || 0,
    banesco_pos_saldo_ant: hoy.banesco_pos_saldo_total || 0,
    bs_efectivo_saldo_ant: hoy.bs_efectivo_saldo_total || 0,
    usd_saldo_ant:         hoy.usd_saldo_total         || 0,
    updated_at: new Date().toISOString(),
  };
  const { error: errUpd } = await sb
    .from("caja_saldo")
    .update(update)
    .eq("id", sig[0].id);
  if (errUpd) { console.warn("Propagación falló:", errUpd); return false; }
  return true;
}

// ------------- Retiro (flujo paso-a-paso) -------------
const RETIRO_STATE = {
  moeda: null,   // "R$" | "Bs" | "USD"
  canal: null,   // "Efectivo" | "Punto" | "PuntoBr" | "USD" | "BCU"
};

// Canales disponibles por moneda con label + ícono
// Canales disponibles por moneda, derivados del catálogo (solo los activos).
// Usa las etiquetas que el admin haya renombrado.
function canalesPorMoeda(moeda) {
  const fuente = (state.canales && state.canales.length > 0) ? state.canales : CANALES_FALLBACK;
  return fuente
    .filter(c => c.moeda === moeda && c.activo !== false)
    .sort((a, b) => (a.orden || 0) - (b.orden || 0))
    .map(c => ({ canal: c.key, label: c.label, icon: c.icon || "💰" }));
}

async function openRetiroModal() {
  // Reset
  RETIRO_STATE.moeda = null;
  RETIRO_STATE.canal = null;
  $("rt_fecha").value = todayISO();
  $("rt_monto").value = "";
  $("rt_destino").value = "";
  $("rt_nota").value = "";
  $("rt_motivo").value = "Pago proveedor";
  $("rt_montoMoedaLabel").textContent = "—";

  // Hide all steps except the first
  ["rt_canalStep","rt_montoStep","rt_motivoStep","rt_notaStep","rt_resumen"].forEach(id => $(id).classList.add("hidden"));
  $("rt_guardar").disabled = true;

  // Reset highlight de botones de moneda
  document.querySelectorAll(".rt-moeda-btn").forEach(b => b.classList.remove("ring-4","ring-rose-400"));

  openModal("modalRetiro");
}

function selectMoeda(moeda) {
  RETIRO_STATE.moeda = moeda;
  RETIRO_STATE.canal = null;

  // Highlight botón seleccionado
  document.querySelectorAll(".rt-moeda-btn").forEach(b => {
    b.classList.toggle("ring-4", b.dataset.moeda === moeda);
    b.classList.toggle("ring-rose-400", b.dataset.moeda === moeda);
  });

  $("rt_montoMoedaLabel").textContent = "Monto en " + moeda;
  cargarVinculosPagos(moeda);

  // Renderizar canales disponibles para esta moneda
  const cont = $("rt_canalOptions");
  const canales = canalesPorMoeda(moeda) || [];
  cont.innerHTML = canales.map(c => `
    <button type="button" data-canal="${c.canal}"
            class="rt-canal-btn flex items-center gap-2 p-2.5 border-2 border-gray-300 rounded-lg text-left hover:border-rose-400 hover:bg-rose-50 transition">
      <span class="text-xl">${c.icon}</span>
      <div class="flex-1">
        <div class="font-semibold text-gray-800 text-sm">${escapeHtml(c.label)}</div>
        <div class="text-[11px] text-gray-500 saldo-canal" data-canal="${c.canal}">Cargando saldo...</div>
      </div>
    </button>
  `).join("");

  // Wire clicks
  cont.querySelectorAll(".rt-canal-btn").forEach(btn => {
    btn.addEventListener("click", () => selectCanal(btn.dataset.canal));
  });

  // Mostrar saldo actual de cada canal (desde el último cierre disponible)
  renderSaldosEnCanales();

  // Mostrar paso 2
  $("rt_canalStep").classList.remove("hidden");
  // Ocultar pasos siguientes hasta que elijan canal
  ["rt_montoStep","rt_motivoStep","rt_notaStep","rt_resumen"].forEach(id => $(id).classList.add("hidden"));
  $("rt_guardar").disabled = true;
}

function renderSaldosEnCanales() {
  const latest = state.cajaSaldos[0];
  if (!latest) return;
  const mapSaldos = {
    Efectivo:   [latest.efectivo_saldo_total,    "R$"],
    PIX:        [latest.pix_saldo_total,         "R$"],
    PuntoBr:    [latest.punto_br_saldo_total,    "R$"],
    PagoMovil:  [bancoBs(latest), "Bs"],
    BanescoPos: [bancoBs(latest), "Bs"],
    BsEfectivo: [latest.bs_efectivo_saldo_total, "Bs"],
    USD:        [latest.usd_saldo_total,         "USD"],
  };
  document.querySelectorAll(".saldo-canal").forEach(el => {
    const c = el.dataset.canal;
    const [v, m] = mapSaldos[c] || [0, ""];
    el.textContent = "Saldo disponible: " + fmtMoeda(v, m);
  });
}

function selectCanal(canal) {
  RETIRO_STATE.canal = canal;

  // Highlight
  document.querySelectorAll(".rt-canal-btn").forEach(b => {
    b.classList.toggle("border-rose-500", b.dataset.canal === canal);
    b.classList.toggle("bg-rose-100", b.dataset.canal === canal);
  });

  // Mostrar saldo disponible del canal elegido
  const latest = state.cajaSaldos[0];
  if (latest) {
    const saldoMap = {
      Efectivo:   latest.efectivo_saldo_total,
      PIX:        latest.pix_saldo_total,
      PuntoBr:    latest.punto_br_saldo_total,
      PagoMovil:  bancoBs(latest),
      BanescoPos: bancoBs(latest),
      BsEfectivo: latest.bs_efectivo_saldo_total,
      USD:        latest.usd_saldo_total,
    };
    const saldo = saldoMap[canal] || 0;
    $("rt_canalSaldo").textContent = "💡 Saldo disponible en " + canalLabel(canal) + ": " + fmtMoeda(saldo, RETIRO_STATE.moeda);
  } else {
    $("rt_canalSaldo").textContent = "⚠️ No hay cierre de caja registrado aún en este rango.";
  }

  // Desbloquear pasos 3, 4, 5
  ["rt_montoStep","rt_motivoStep","rt_notaStep"].forEach(id => $(id).classList.remove("hidden"));
  actualizarResumenRetiro();
  $("rt_monto").focus();
}

function actualizarResumenRetiro() {
  const m = RETIRO_STATE;
  const monto = Number($("rt_monto").value || 0);
  const nota = $("rt_nota").value.trim();
  const motivo = $("rt_motivo").value;
  const destino = $("rt_destino").value.trim();

  const ok = m.moeda && m.canal && monto > 0 && nota.length >= 3;

  if (m.moeda && m.canal && monto > 0) {
    $("rt_resumen").classList.remove("hidden");
    $("rt_resumenTexto").innerHTML = `
      Sale <b>${fmtMoeda(monto, m.moeda)}</b> de <b>${escapeHtml(canalLabel(m.canal))}</b><br>
      ${escapeHtml(motivo)}${destino ? " → " + escapeHtml(destino) : ""}<br>
      ${nota ? "💬 " + escapeHtml(nota) : '<span class="text-rose-700">⚠ Falta nota de uso</span>'}
    `;
  } else {
    $("rt_resumen").classList.add("hidden");
  }

  $("rt_guardar").disabled = !ok;
}

async function guardarRetiro() {
  // Guard contra doble-click: si ya está procesando, ignorar.
  const btn = $("rt_guardar");
  if (btn.disabled && btn.dataset.saving === "1") return;

  const { moeda, canal } = RETIRO_STATE;
  const monto = Number($("rt_monto").value);
  const nota = $("rt_nota").value.trim();

  // Validaciones
  if (!moeda) { toast("Elegí la moneda"); return; }
  if (!canal) { toast("Elegí de qué caja sale"); return; }
  if (!monto || monto <= 0) { toast("Monto inválido"); return; }
  if (!nota || nota.length < 3) { toast("Poné una nota de en qué se usó el dinero"); return; }
  // 30/09: si es efectivo y aún quedan billetes deteriorados, preguntar si este retiro es de esos billetes
  // (un retiro de 207 se guardó como "Retiro propio" y la tarjeta de deteriorados no bajó)
  if (canal === "Efectivo" && DET_DISPONIBLE > 0 && !MOTIVOS_DETERIORADOS.includes($("rt_motivo").value)
      && /deterior|viej|billete|da[ñn]ad|dep[oó]sit|banco/i.test(nota + " " + $("rt_destino").value)) {
    if (confirm(`¿Este retiro es de los BILLETES DETERIORADOS? (hay ${fmtR(DET_DISPONIBLE)})\n\nAceptar = Sí, descontarlo de los deteriorados\nCancelar = No, es efectivo normal`)) {
      $("rt_motivo").value = confirm("¿Fue un DEPÓSITO al banco?\n\nAceptar = Depósito al banco\nCancelar = Gasto / pago con esos billetes") ? MOTIVOS_DETERIORADOS[0] : MOTIVOS_DETERIORADOS[1];
    }
  }
  if (MOTIVOS_DETERIORADOS.includes($("rt_motivo").value)) {
    if (canal !== "Efectivo") { toast("Los billetes deteriorados salen de Efectivo R$"); return; }
    if (monto > DET_DISPONIBLE + 0.005) { toast(`⛔ Solo hay ${fmtR(DET_DISPONIBLE)} en billetes deteriorados`, 5000); return; }
  }

  btn.disabled = true;
  btn.dataset.saving = "1";
  const _rtOrigLabel = btn.textContent;
  btn.textContent = "Guardando…";
  try {

  // Chequeo saldo (warning, no bloqueo — puede ser que cargues el movimiento antes del cierre)
  const latest = state.cajaSaldos[0];
  if (latest) {
    const saldoMap = {
      Efectivo:   latest.efectivo_saldo_total,
      PIX:        latest.pix_saldo_total,
      PuntoBr:    latest.punto_br_saldo_total,
      PagoMovil:  bancoBs(latest),
      BanescoPos: bancoBs(latest),
      BsEfectivo: latest.bs_efectivo_saldo_total,
      USD:        latest.usd_saldo_total,
    };
    const disponible = Number(saldoMap[canal] || 0);
    if (monto > disponible) {
      if (!confirm(`⚠ El monto (${fmtMoeda(monto, moeda)}) supera el saldo disponible (${fmtMoeda(disponible, moeda)}) en ${canalLabel(canal)}. ¿Guardar igual?`)) return;
    }
  }

  const fecha = $("rt_fecha").value;

  // Buscar caja_saldo_id del día (si existe) para vincular
  let caja_saldo_id = null;
  const { data: found } = await sb.from("caja_saldo").select("id").eq("fecha", fecha).limit(1);
  if (found && found[0]) caja_saldo_id = found[0].id;

  const payload = {
    fecha,
    caja_saldo_id,
    canal,
    moeda,
    monto,
    motivo: $("rt_motivo").value,
    destino: $("rt_destino").value || null,
    nota,
  };

  // Vinculo con OiMira Pagos: validar ANTES de guardar
  const vincSel = $("rt_vinculo") ? $("rt_vinculo").value : "";
  if (vincSel) {
    const it = (VINCULOS_PAGOS || []).find(v => v.key === vincSel);
    if (it && monto > Number(it.saldo)) {
      toast(`⛔ El retiro (${fmtMoeda(monto, moeda)}) es mayor que el saldo de "${it.nombre}" (${fmtMoeda(it.saldo, moeda)}). Ajusta el monto o quita el vínculo.`, 5000);
      return;
    }
  }

  const { data: retIns, error } = await sb.from("caja_retiro").insert(payload).select("id").single();
  if (error) { toast("Error: " + error.message, 4000); return; }

  // Registrar el pago/abono en OiMira Pagos
  if (vincSel && retIns) {
    const tipo = vincSel.slice(0, 1), pid = vincSel.slice(2);
    const rp = await sbPagos.rpc("pagos_abonar_vinculo", { p_token: localStorage.getItem("oimira_admin_token"), p_tipo: tipo, p_id: pid,
      p_monto: monto, p_nota: "Retiro caja: " + nota, p_retiro: retIns.id });
    if (rp.error) toast("Retiro guardado, pero el vínculo con Pagos falló: " + rp.error.message, 5000);
    else {
      const d = rp.data || {};
      toast(d.pagada ? "💳 Factura marcada PAGADA en OiMira Pagos" : "💳 Abono registrado en OiMira Pagos (saldo " + fmtMoeda(d.saldo, moeda) + ")", 4500);
    }
  }

  // Si el retiro está vinculado a un cierre, propagar el saldo recalculado
  // al día siguiente automáticamente.
  let propagado = false;
  if (caja_saldo_id) propagado = await propagarSaldoAlDiaSiguiente(fecha);

    toast(propagado
      ? `Retiro registrado · saldo del día siguiente recalculado`
      : `Retiro de ${fmtMoeda(monto, moeda)} registrado`);
    closeModal("modalRetiro");
    reload();
  } finally {
    btn.disabled = false;
    btn.dataset.saving = "";
    btn.textContent = _rtOrigLabel;
  }
}

// ------------- Reconciliar cadena entera de saldos -------------
// Pregunta una fecha de inicio y recorre TODOS los cierres a partir de ahí,
// recalculando saldo_ant de cada uno con el saldo_total del anterior.
async function reconciliarCadena() {
  const desde = prompt(
    "Reconciliar saldos a partir de qué fecha (YYYY-MM-DD)?\n\n" +
    "Para cada día desde esta fecha, el saldo_ant se va a recalcular\n" +
    "con el saldo_total real del día anterior (incluyendo retiros).\n\n" +
    "Dejar vacío para cancelar.",
    daysAgo(7)
  );
  if (!desde) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) { toast("Fecha inválida. Usá YYYY-MM-DD"); return; }

  // Traer todos los cierres ordenados desde la fecha
  const { data: cierres, error } = await sb
    .from("caja_saldo")
    .select("id, fecha")
    .gte("fecha", desde)
    .order("fecha", { ascending: true });
  if (error) { toast("Error: " + error.message, 4000); return; }
  if (!cierres || cierres.length < 2) {
    toast("Hace falta al menos 2 cierres consecutivos para reconciliar");
    return;
  }

  let actualizados = 0;
  // Para cada par consecutivo, traer el saldo_total del anterior y pisar el siguiente
  for (let i = 0; i < cierres.length - 1; i++) {
    const prev = cierres[i];
    const curr = cierres[i + 1];

    const { data: prevResumen } = await sb
      .from("caja_saldo_resumen")
      .select("efectivo_saldo_total, pix_saldo_total, punto_br_saldo_total, pago_movil_saldo_total, banesco_pos_saldo_total, bs_efectivo_saldo_total, usd_saldo_total")
      .eq("fecha", prev.fecha)
      .maybeSingle();
    if (!prevResumen) continue;

    const update = {
      efectivo_saldo_ant:    prevResumen.efectivo_saldo_total    || 0,
      pix_saldo_ant:         prevResumen.pix_saldo_total         || 0,
      punto_br_saldo_ant:    prevResumen.punto_br_saldo_total    || 0,
      pago_movil_saldo_ant:  prevResumen.pago_movil_saldo_total  || 0,
      banesco_pos_saldo_ant: prevResumen.banesco_pos_saldo_total || 0,
      bs_efectivo_saldo_ant: prevResumen.bs_efectivo_saldo_total || 0,
      usd_saldo_ant:         prevResumen.usd_saldo_total         || 0,
      updated_at: new Date().toISOString(),
    };
    const { error: errUpd } = await sb
      .from("caja_saldo")
      .update(update)
      .eq("id", curr.id);
    if (!errUpd) actualizados++;
  }

  toast(`Reconciliación lista · ${actualizados} cierre(s) actualizado(s)`, 4000);
  reload();
}

// ------------- Wire caja listeners (se llama desde init) -------------
function wireCajaListeners() {
  wireModalClose();
  $("nuevoCierreCajaBtn").addEventListener("click", openCierreCajaModal);
  $("nuevoRetiroBtn").addEventListener("click", openRetiroModal);
  $("cc_guardar").addEventListener("click", guardarCierreCaja);
  $("rt_guardar").addEventListener("click", guardarRetiro);
  const reconBtn = document.getElementById("reconciliarSaldosBtn");
  if (reconBtn) reconBtn.addEventListener("click", reconciliarCadena);
  // Recalc en vivo del cierre de caja (7 canales)
  ["cc_efectivo_ant","cc_efectivo_hoy","cc_gastos_efectivo",
   "cc_pix_ant","cc_pix_hoy",
   "cc_puntobr_ant","cc_puntobr_hoy",
   "cc_pago_movil_ant","cc_pago_movil_hoy",
   "cc_banesco_pos_ant","cc_banesco_pos_hoy",
   "cc_bs_efectivo_ant","cc_bs_efectivo_hoy",
   "cc_usd_ant","cc_usd_hoy"].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener("input", recalcCC);
  });
  // Botón Re-sincronizar con lo que reportó la cajera
  const resyncBtn = document.getElementById("cc_resync");
  if (resyncBtn) resyncBtn.addEventListener("click", resyncDesdeCajera);

  // Al cambiar la fecha, recargar los datos de ese día (nuevo o editar)
  $("cc_fecha").addEventListener("change", (e) => cargarCierreCaja(e.target.value));

  // Retiro: selector de moneda
  document.querySelectorAll(".rt-moeda-btn").forEach(btn => {
    btn.addEventListener("click", () => selectMoeda(btn.dataset.moeda));
  });
  // Retiro: validación en vivo del resumen
  ["rt_monto","rt_nota","rt_motivo","rt_destino"].forEach(id => {
    $(id).addEventListener("input", actualizarResumenRetiro);
    $(id).addEventListener("change", actualizarResumenRetiro);
  });

  // Toggle evolución: Saldo total vs Entrada del día
  document.querySelectorAll(".evol-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.evolMetric = btn.dataset.metric;
      document.querySelectorAll(".evol-btn").forEach(b => {
        b.classList.remove("bg-amber-500", "text-white");
        b.classList.add("bg-gray-200");
      });
      btn.classList.remove("bg-gray-200");
      btn.classList.add("bg-amber-500", "text-white");
      renderCajaEvolucion();
    });
  });
}

// ============================================================
// Arranque
// ============================================================
// Sello de versión (para confirmar qué build está cargado en el dispositivo)

// 🩹 Fondo de billetes deteriorados = registrado por cajera − (depositado al banco + gastado)
// 30/09/2026 (Polley): botón "💸 Sacar / gastar" en la tarjeta; se puede depositar o gastar (pagar con ellos).
const MOTIVOS_DETERIORADOS = ["Depósito billetes deteriorados", "Gasto con billetes deteriorados"];
let DET_DISPONIBLE = 0;
async function renderDeteriorado() {
  try {
    const [{ data: acum }, { data: dep }] = await Promise.all([
      sb.from("dia_cierre").select("efectivo_deteriorado_rs"),
      sb.from("caja_retiro").select("monto,motivo").eq("canal", "Efectivo").in("motivo", MOTIVOS_DETERIORADOS),
    ]);
    const entrado = (acum || []).reduce((s, r) => s + Number(r.efectivo_deteriorado_rs || 0), 0);
    const depositado = (dep || []).filter(r => r.motivo === MOTIVOS_DETERIORADOS[0]).reduce((s, r) => s + Number(r.monto || 0), 0);
    const gastado = (dep || []).filter(r => r.motivo === MOTIVOS_DETERIORADOS[1]).reduce((s, r) => s + Number(r.monto || 0), 0);
    DET_DISPONIBLE = Math.round((entrado - depositado - gastado) * 100) / 100;
    const card = document.getElementById("cardDeteriorado");
    if (!card) return;
    card.style.display = (entrado > 0 || depositado > 0 || gastado > 0) ? "" : "none";
    const t = document.getElementById("detTotal"); if (t) t.textContent = fmtR(DET_DISPONIBLE);
    const d = document.getElementById("detDetalle"); if (d) d.textContent = `Registrado ${fmtR(entrado)} · Depositado ${fmtR(depositado)}` + (gastado ? ` · Gastado ${fmtR(gastado)}` : "");
    const b = document.getElementById("btnDeteriorados"); if (b) b.disabled = DET_DISPONIBLE <= 0;
  } catch (e) { console.error("renderDeteriorado", e); }
}
// Abre el retiro ya listo: R$ → Efectivo → motivo deteriorados. Solo falta monto, depósito/gasto y la nota.
async function abrirRetiroDeteriorados() {
  await openRetiroModal();
  selectMoeda("R$");
  selectCanal("Efectivo");
  $("rt_motivo").value = MOTIVOS_DETERIORADOS[0];
  $("rt_monto").value = DET_DISPONIBLE > 0 ? String(DET_DISPONIBLE) : "";
  $("rt_canalSaldo").textContent = "🩹 Billetes deteriorados disponibles: " + fmtR(DET_DISPONIBLE) + " — elige abajo si es depósito al banco o gasto.";
  actualizarResumenRetiro();
}
(function () { const b = document.getElementById("btnDeteriorados"); if (b) b.addEventListener("click", (e) => { e.stopPropagation(); abrirRetiroDeteriorados(); }); })();

// ➕ INGRESAR DINERO (30/09/2026, pedido de Polley): SOLO EL DUEÑO. Sobrantes que entran a la caja.
// El servidor (RPC caja_ingresar) verifica que el token sea del dueño; nadie más puede grabar montos negativos.
// Se guarda en caja_retiro con monto NEGATIVO y motivo "Ingreso / sobrante de efectivo" (negativo = entra).
async function mostrarBotonIngresar() {
  const b = document.getElementById("ingresarDineroBtn"); if (!b) return;
  const tk = localStorage.getItem("oimira_admin_token");
  if (!tk || !navigator.onLine) { b.style.display = "none"; return; }
  try {
    const { data } = await sbPagos.rpc("caja_es_dueno", { p_token: tk });
    b.style.display = data === true ? "" : "none";
  } catch (e) { b.style.display = "none"; }
}
function abrirIngresarDinero() {
  const canales = (state.canales || []).filter(c => c.activo !== false);
  const opts = (canales.length ? canales : [{ key: "Efectivo", label: "Efectivo R$", moeda: "R$" }])
    .map(c => `<option value="${escapeHtml(c.key)}" ${c.key === "Efectivo" ? "selected" : ""}>${escapeHtml((c.icon || "") + " " + c.label)} (${escapeHtml(c.moeda)})</option>`).join("");
  const ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,.6);display:grid;place-items:center;z-index:9999;padding:16px";
  ov.innerHTML = `<div style="background:#fff;border-radius:16px;padding:18px;max-width:380px;width:100%;font-family:system-ui,sans-serif">
    <div style="font-size:17px;font-weight:800;color:#065f46">➕ Ingresar dinero a la caja</div>
    <div style="font-size:12px;color:#475569;margin:4px 0 10px">Solo tú ves este botón. Úsalo para sobrantes o dinero que entra a la caja fuera del cierre.</div>
    <label style="font-size:12px;font-weight:600">Caja</label>
    <select id="ing_canal" style="width:100%;padding:8px;border:2px solid #cbd5e1;border-radius:10px;margin-bottom:8px">${opts}</select>
    <div style="display:flex;gap:8px">
      <div style="flex:1"><label style="font-size:12px;font-weight:600">Monto</label>
        <input id="ing_monto" type="number" step="0.01" min="0" placeholder="0.00" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #6ee7b7;border-radius:10px;font-size:18px;font-weight:700;text-align:right"></div>
      <div><label style="font-size:12px;font-weight:600">Fecha</label>
        <input id="ing_fecha" type="date" value="${todayISO()}" style="padding:8px;border:2px solid #cbd5e1;border-radius:10px"></div>
    </div>
    <label style="font-size:12px;font-weight:600;display:block;margin-top:8px">¿De dónde sale? *</label>
    <input id="ing_nota" placeholder="Ej: sobrante de efectivo al contar la caja" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #cbd5e1;border-radius:10px">
    <div style="display:flex;gap:8px;margin-top:12px">
      <button id="ing_cancelar" style="flex:1;padding:10px;border:2px solid #cbd5e1;border-radius:10px;background:#fff;font-weight:600">Cancelar</button>
      <button id="ing_guardar" style="flex:1;padding:10px;border:0;border-radius:10px;background:#059669;color:#fff;font-weight:700">Ingresar</button>
    </div></div>`;
  document.body.appendChild(ov);
  const cerrar = () => ov.remove();
  ov.querySelector("#ing_cancelar").onclick = cerrar;
  setTimeout(() => ov.querySelector("#ing_monto").focus(), 50);
  ov.querySelector("#ing_guardar").onclick = async (ev) => {
    const btn = ev.currentTarget;
    const canal = ov.querySelector("#ing_canal").value, monto = Number(ov.querySelector("#ing_monto").value || 0);
    const fecha = ov.querySelector("#ing_fecha").value, nota = ov.querySelector("#ing_nota").value.trim();
    if (!(monto > 0)) return toast("Escribe el monto");
    if (nota.length < 3) return toast("Escribe de dónde sale el dinero");
    if (!navigator.onLine) return toast("📵 Sin conexión: para ingresar dinero hace falta señal");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const { data, error } = await sbPagos.rpc("caja_ingresar", { p_token: localStorage.getItem("oimira_admin_token"), p_fecha: fecha, p_canal: canal, p_monto: monto, p_nota: nota });
      if (error) throw error;
      await propagarSaldoAlDiaSiguiente(fecha);
      toast(`✅ Ingresado ${fmtMoeda(monto, data.moeda)} a ${canalLabel(canal)}`, 5000);
      cerrar(); reload();
    } catch (e) { toast("No se ingresó: " + (e.message || e), 6000); btn.disabled = false; btn.textContent = "Ingresar"; }
  };
}
(function () {
  const b = document.getElementById("ingresarDineroBtn");
  if (b) b.addEventListener("click", abrirIngresarDinero);
  mostrarBotonIngresar();
})();

// Sello visible. Usa la MISMA constante que el service worker para que no puedan
// contradecirse: era justo el bug que hacía parecer que la app no se actualizaba.
(function(){
  ["adminVersion", "appVersion"].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.textContent = "📊 Admin · v" + APP_BUILD;
  });
})();
setupPinGate();
