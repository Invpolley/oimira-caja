// OiMira Admin — lógica del panel
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_PIN } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
};

// ============================================================
// Utilidades
// ============================================================
const $ = (id) => document.getElementById(id);
const fmtR = (n) => "R$ " + (Number(n) || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtB = (n) => "Bs " + (Number(n) || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtU = (n) => "US$ " + (Number(n) || 0).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtN = (n) => (Number(n) || 0).toLocaleString("es-AR");
const fmtMoeda = (n, m) => m === "Bs" ? fmtB(n) : m === "USD" ? fmtU(n) : fmtR(n);
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

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
  return Date.now() < until;
}

function unlockUI() {
  $("pinGate").classList.add("hidden");
  $("app").classList.remove("hidden");
  init();
}

function setupPinGate() {
  if (checkPinSession()) {
    unlockUI();
    return;
  }
  const input = $("pinInput");
  input.focus();
  const submit = () => {
    if (input.value === ADMIN_PIN) {
      // sesión 12h
      localStorage.setItem("oimira_admin_pin_until", String(Date.now() + 12 * 3600 * 1000));
      unlockUI();
    } else {
      $("pinError").classList.remove("hidden");
      input.value = "";
      input.focus();
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
    .select("*,forma_pago_extra(*),dia_gasto(*)")
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
function calcCierre(c) {
  const extraR = (c.forma_pago_extra || [])
    .filter(fp => fp.moeda === "R$")
    .reduce((s, fp) => s + Number(fp.monto || 0), 0);
  const extraB = (c.forma_pago_extra || [])
    .filter(fp => fp.moeda === "Bs")
    .reduce((s, fp) => s + Number(fp.monto || 0), 0);
  const gastoR = (c.dia_gasto || [])
    .filter(g => g.moeda === "R$")
    .reduce((s, g) => s + Number(g.monto || 0), 0);
  const gastoB = (c.dia_gasto || [])
    .filter(g => g.moeda === "Bs")
    .reduce((s, g) => s + Number(g.monto || 0), 0);

  const ingR = Number(c.pix_rs || 0) + Number(c.dinheiro_rs || 0) + Number(c.debito_rs || 0) + extraR;
  const ingB = Number(c.pago_movil_bs || 0) + Number(c.bs_efectivo_bs || 0) + extraB;

  return {
    ingR, ingB, gastoR, gastoB,
    netoR: ingR - gastoR,
    netoB: ingB - gastoB,
    extraR, extraB,
  };
}

// ============================================================
// Render KPIs
// ============================================================
function renderKPIs() {
  let totR = 0, totB = 0, totGasR = 0, totGasB = 0;
  for (const c of state.cierres) {
    const k = calcCierre(c);
    totR += k.ingR;
    totB += k.ingB;
    totGasR += k.gastoR;
    totGasB += k.gastoB;
  }
  $("kpiIngRs").textContent = fmtR(totR);
  $("kpiIngBs").textContent = fmtB(totB);
  $("kpiGastos").textContent = fmtR(totGasR) + " / " + fmtB(totGasB);
  $("kpiDias").textContent = state.cierres.length;
  const d1 = state.rango.desde, d2 = state.rango.hasta;
  $("kpiDiasRango").textContent = `(${fmtFecha(d1)} → ${fmtFecha(d2)})`;
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
function renderDias() {
  const list = $("diasList");
  list.innerHTML = "";
  $("emptyState").classList.toggle("hidden", state.cierres.length > 0);
  $("loadingState").classList.add("hidden");

  for (const c of state.cierres) {
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
      if (Number(c.debito_rs) > 0) formasHtml.push(`<span class="pill pill-r">Débito ${fmtR(c.debito_rs)}</span>`);
      if (Number(c.pago_movil_bs) > 0) formasHtml.push(`<span class="pill pill-b">Pago Móvil ${fmtB(c.pago_movil_bs)}</span>`);
      if (Number(c.bs_efectivo_bs) > 0) formasHtml.push(`<span class="pill pill-b">Bs efectivo ${fmtB(c.bs_efectivo_bs)}</span>`);
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
              👤 Cajera: <b>${escapeHtml(c.cajera || "—")}</b> · 📤 Enviado: ${c.submitted_at ? new Date(c.submitted_at).toLocaleString("es-AR") : "—"}
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
    "total_ing_rs", "total_ing_bs",
    "gastos_rs", "gastos_bs",
    "neto_rs", "neto_bs",
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
      k.ingR.toFixed(2), k.ingB.toFixed(2),
      k.gastoR.toFixed(2), k.gastoB.toFixed(2),
      k.netoR.toFixed(2), k.netoB.toFixed(2),
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
async function reload() {
  $("loadingState").classList.remove("hidden");
  $("diasList").innerHTML = "";
  $("emptyState").classList.add("hidden");
  try {
    const [cierres, cajaSaldos, cajaRetiros] = await Promise.all([
      fetchCierres(state.rango.desde, state.rango.hasta),
      fetchCajaSaldos(state.rango.desde, state.rango.hasta),
      fetchCajaRetiros(state.rango.desde, state.rango.hasta),
    ]);
    state.cierres = cierres;
    state.cajaSaldos = cajaSaldos;
    state.cajaRetiros = cajaRetiros;
    state.expanded.clear();
    state.allExpanded = false;
    $("toggleAllBtn").textContent = "Expandir todo";
    renderKPIs();
    renderChart();
    renderDias();
    renderPorCajera();
    renderPorCategoria();
    renderCajaSaldos();
    renderCajaRetiros();
    renderCajaEvolucion();
  } catch (e) {
    console.error(e);
  }
}

function setRango(desde, hasta) {
  state.rango.desde = desde;
  state.rango.hasta = hasta;
  $("fechaDesde").value = desde;
  $("fechaHasta").value = hasta;
  reload();
}

// ============================================================
// Init + event listeners
// ============================================================
function init() {
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
    location.reload();
  });

  // Online/offline indicator
  window.addEventListener("online", () => setStatus("online", "Conectado"));
  window.addEventListener("offline", () => setStatus("offline", "Sin conexión"));

  // Refresco automático cada 60s
  setInterval(() => {
    if (!document.hidden) reload();
  }, 60000);

  // Wire del módulo de caja (modales, retiros, etc)
  wireCajaListeners();
}

// ============================================================
// Service worker
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(err => {
      console.warn("SW register failed:", err);
    });
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

// ------------- Render cards -------------
function renderCajaSaldos() {
  // El card superior muestra los saldos del último cierre disponible (más reciente)
  const latest = state.cajaSaldos[0];
  const label = $("cajaFechaLabel");
  if (!latest) {
    label.textContent = "Sin cierres de caja en este rango";
    $("cajaEfectivo").textContent = fmtR(0);
    $("cajaPunto").textContent = fmtB(0);
    $("cajaPuntoBr").textContent = fmtR(0);
    $("cajaUsd").textContent = fmtU(0);
    $("cajaBcu").textContent = fmtR(0);
    $("cajaTotalEfectivo").textContent = fmtR(0);
    $("cajaRecargas").textContent = "—";
    ["cajaEfectivoDetail","cajaPuntoDetail","cajaPuntoBrDetail","cajaUsdDetail"].forEach(id => $(id).textContent = "");
    return;
  }
  label.textContent = `Último cierre: ${fmtFecha(latest.fecha)} · Polley`;

  // Efectivo
  $("cajaEfectivo").textContent = fmtR(latest.efectivo_saldo_total);
  $("cajaEfectivoDetail").textContent = `ant ${fmtN(latest.efectivo_saldo_ant)} + hoy ${fmtN(latest.efectivo_hoy)}${Number(latest.gastos_efectivo_hoy) > 0 ? " − gastos " + fmtN(latest.gastos_efectivo_hoy) : ""}`;

  // Punto (Bs)
  $("cajaPunto").textContent = fmtB(latest.punto_saldo_total);
  $("cajaPuntoDetail").textContent = `ant ${fmtN(latest.punto_saldo_ant)} + hoy ${fmtN(latest.punto_hoy)}`;

  // Punto Br (R$)
  $("cajaPuntoBr").textContent = fmtR(latest.punto_br_saldo_total);
  $("cajaPuntoBrDetail").textContent = `ant ${fmtN(latest.punto_br_saldo_ant)} + hoy ${fmtN(latest.punto_br_hoy)}`;

  // USD
  $("cajaUsd").textContent = fmtU(latest.usd_saldo_total);
  $("cajaUsdDetail").textContent = `ant ${fmtN(latest.usd_saldo_ant)} + hoy ${fmtN(latest.usd_hoy)}`;

  // BCU
  $("cajaBcu").textContent = fmtR(latest.bcu_saldo);

  // Total
  $("cajaTotalEfectivo").textContent = fmtR(latest.efectivo_saldo_total);
  $("cajaRecargas").textContent = Number(latest.transf_recarga || 0) > 0
    ? fmtMoeda(latest.transf_recarga, latest.transf_recarga_moeda || "R$")
    : "—";
}

function renderCajaRetiros() {
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
      if (!confirm("¿Eliminar este retiro?")) return;
      const { error } = await sb.from("caja_retiro").delete().eq("id", btn.dataset.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Retiro eliminado");
      reload();
    });
  });
}

function canalLabel(c) {
  return { Efectivo: "Efectivo R$", Punto: "Punto Bs", PuntoBr: "Punto Br R$", USD: "USD", BCU: "BCU" }[c] || c;
}
function canalIcon(c) {
  return { Efectivo: "💵", Punto: "📲", PuntoBr: "💳", USD: "💵", BCU: "🏦" }[c] || "💰";
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
function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }

function wireModalClose() {
  document.querySelectorAll(".close-modal").forEach(btn => {
    btn.addEventListener("click", () => closeModal(btn.dataset.modal));
  });
  // click fuera del contenido cierra
  ["modalCierreCaja", "modalRetiro"].forEach(id => {
    $(id).addEventListener("click", (e) => {
      if (e.target.id === id) closeModal(id);
    });
  });
}

// ------------- Cierre de caja (nuevo / edit) -------------
async function openCierreCajaModal() {
  const today = todayISO();
  $("cc_fecha").value = today;

  // Traer el último cierre para autocompletar "anterior" y poner en 0 los "hoy"
  const last = await fetchUltimoSaldo(today);
  if (last) {
    $("cc_efectivo_ant").value = last.efectivo_saldo_total || 0;
    $("cc_punto_ant").value = last.punto_saldo_total || 0;
    $("cc_puntobr_ant").value = last.punto_br_saldo_total || 0;
    $("cc_usd_ant").value = last.usd_saldo_total || 0;
    $("cc_bcu").value = last.bcu_saldo || 0;
  } else {
    ["cc_efectivo_ant","cc_punto_ant","cc_puntobr_ant","cc_usd_ant","cc_bcu"].forEach(id => $(id).value = 0);
  }
  ["cc_efectivo_hoy","cc_gastos_efectivo","cc_punto_hoy","cc_puntobr_hoy","cc_usd_hoy","cc_recarga"].forEach(id => $(id).value = 0);
  $("cc_notas").value = "";

  recalcCC();
  openModal("modalCierreCaja");
}

function recalcCC() {
  const efAnt = Number($("cc_efectivo_ant").value) || 0;
  const efHoy = Number($("cc_efectivo_hoy").value) || 0;
  const gas = Number($("cc_gastos_efectivo").value) || 0;
  $("cc_efectivo_total").textContent = fmtR(efAnt + efHoy - gas);

  const pAnt = Number($("cc_punto_ant").value) || 0;
  const pHoy = Number($("cc_punto_hoy").value) || 0;
  $("cc_punto_total").textContent = fmtB(pAnt + pHoy);

  const pbAnt = Number($("cc_puntobr_ant").value) || 0;
  const pbHoy = Number($("cc_puntobr_hoy").value) || 0;
  $("cc_puntobr_total").textContent = fmtR(pbAnt + pbHoy);

  const uAnt = Number($("cc_usd_ant").value) || 0;
  const uHoy = Number($("cc_usd_hoy").value) || 0;
  $("cc_usd_total").textContent = fmtU(uAnt + uHoy);
}

async function guardarCierreCaja() {
  const payload = {
    fecha: $("cc_fecha").value,
    efectivo_saldo_ant: Number($("cc_efectivo_ant").value) || 0,
    efectivo_hoy: Number($("cc_efectivo_hoy").value) || 0,
    gastos_efectivo_hoy: Number($("cc_gastos_efectivo").value) || 0,
    punto_saldo_ant: Number($("cc_punto_ant").value) || 0,
    punto_hoy: Number($("cc_punto_hoy").value) || 0,
    punto_br_saldo_ant: Number($("cc_puntobr_ant").value) || 0,
    punto_br_hoy: Number($("cc_puntobr_hoy").value) || 0,
    usd_saldo_ant: Number($("cc_usd_ant").value) || 0,
    usd_hoy: Number($("cc_usd_hoy").value) || 0,
    bcu_saldo: Number($("cc_bcu").value) || 0,
    transf_recarga: Number($("cc_recarga").value) || 0,
    notas: $("cc_notas").value || null,
    cajera: "Polley",
    updated_at: new Date().toISOString(),
  };
  if (!payload.fecha) { toast("Poné una fecha"); return; }

  const { error } = await sb.from("caja_saldo").upsert(payload, { onConflict: "fecha" });
  if (error) { toast("Error: " + error.message, 4000); return; }

  toast("Cierre de caja guardado");
  closeModal("modalCierreCaja");
  reload();
}

// ------------- Retiro -------------
async function openRetiroModal() {
  $("rt_fecha").value = todayISO();
  $("rt_monto").value = "";
  $("rt_destino").value = "";
  $("rt_nota").value = "";
  $("rt_canal").value = "Efectivo|R$";
  $("rt_motivo").value = "Pago proveedor";
  openModal("modalRetiro");
}

async function guardarRetiro() {
  const [canal, moeda] = $("rt_canal").value.split("|");
  const monto = Number($("rt_monto").value);
  if (!monto || monto <= 0) { toast("Monto inválido"); return; }
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
    nota: $("rt_nota").value || null,
  };

  const { error } = await sb.from("caja_retiro").insert(payload);
  if (error) { toast("Error: " + error.message, 4000); return; }

  toast("Retiro registrado");
  closeModal("modalRetiro");
  reload();
}

// ------------- Wire caja listeners (se llama desde init) -------------
function wireCajaListeners() {
  wireModalClose();
  $("nuevoCierreCajaBtn").addEventListener("click", openCierreCajaModal);
  $("nuevoRetiroBtn").addEventListener("click", openRetiroModal);
  $("cc_guardar").addEventListener("click", guardarCierreCaja);
  $("rt_guardar").addEventListener("click", guardarRetiro);
  // Recalc en vivo
  ["cc_efectivo_ant","cc_efectivo_hoy","cc_gastos_efectivo",
   "cc_punto_ant","cc_punto_hoy",
   "cc_puntobr_ant","cc_puntobr_hoy",
   "cc_usd_ant","cc_usd_hoy"].forEach(id => {
    $(id).addEventListener("input", recalcCC);
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
setupPinGate();
