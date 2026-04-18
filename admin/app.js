// OiMira Admin — lógica del panel
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_PIN } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// Estado
// ============================================================
const state = {
  cierres: [],      // array de dia_cierre con joins
  rango: { desde: null, hasta: null },
  chartMode: "ingresos",
  expanded: new Set(),
  allExpanded: false,
  chart: null,
};

// ============================================================
// Utilidades
// ============================================================
const $ = (id) => document.getElementById(id);
const fmtR = (n) => "R$ " + (Number(n) || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtB = (n) => "Bs " + (Number(n) || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtN = (n) => (Number(n) || 0).toLocaleString("es-AR");
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
    state.cierres = await fetchCierres(state.rango.desde, state.rango.hasta);
    state.expanded.clear();
    state.allExpanded = false;
    $("toggleAllBtn").textContent = "Expandir todo";
    renderKPIs();
    renderChart();
    renderDias();
    renderPorCajera();
    renderPorCategoria();
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
// Arranque
// ============================================================
setupPinGate();
