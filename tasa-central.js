// 💱 Tasa de cambio central (27/09/2026, pedido de Polley) — la misma pieza en Caja y en el admin de cierres.
// Fuente única: hub_config.tasas (config.fitmassa.com → 🔧 Parámetros). Todas las apps usan la PARALELA vigente.
// Leer: RPC pública tasa_vigente (copia en el equipo para trabajar sin señal).
// Cambiar: RPC tasa_cambiar con el PIN personal (dueño o permiso "Cambiar la tasa de cambio"): queda registrado
// quién, desde qué app, fecha y hora. Los cierres ya enviados conservan su propia tasa (no se tocan).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const COPIA = "oimira_tasa_vigente_v1";
let VIG = (() => { try { return JSON.parse(localStorage.getItem(COPIA) || "null"); } catch (e) { return null; } })();
let _pub = null;
const nf = (n, d = 2) => (n == null || !isFinite(n)) ? "—" : Number(n).toLocaleString("es-VE", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function tasaVigente() { return VIG; }
/** 1 Bs = X R$ (formato de Caja) o null si todavía no hay tasa central */
export function rsPorBs() { return VIG && Number(VIG.rs_por_bs) > 0 ? Number(VIG.rs_por_bs) : null; }
/** 1 USD = X R$ o null */
export function rsPorUsd() { return VIG && Number(VIG.rs_por_usd) > 0 ? Number(VIG.rs_por_usd) : null; }

export async function cargarTasaVigente(url, key) {
  if (!navigator.onLine) return VIG;
  try {
    _pub = _pub || createClient(url, key);
    const { data, error } = await _pub.rpc("tasa_vigente");
    if (!error && data) { VIG = data; try { localStorage.setItem(COPIA, JSON.stringify(data)); } catch (e) { /* */ } }
  } catch (e) { /* sin señal: queda la copia */ }
  return VIG;
}

export function textoVigente() {
  if (!VIG) return "Todavía no hay tasa central guardada (se usa la de siempre). Se cambia con el botón de abajo o en config.fitmassa.com.";
  const ofi = (VIG.oficial_bs_rs > 0 || VIG.oficial_bs_usd > 0)
    ? `<br><span style="color:#6b7280">Oficial (solo referencia): 1 R$ = ${nf(VIG.oficial_bs_rs)} Bs · 1 USD = ${nf(VIG.oficial_bs_usd)} Bs</span>`
    : `<br><span style="color:#6b7280">Oficial (solo referencia): sin cargar</span>`;
  return `Paralela (la que usamos): <b>1 R$ = ${nf(VIG.paralelo_bs_rs)} Bs</b> · <b>1 USD = ${nf(VIG.paralelo_bs_usd)} Bs</b> · 1 USD = ${nf(VIG.rs_por_usd, 2)} R$` + ofi +
    `<br><span style="opacity:.8">Puesta por ${esc(VIG.usuario)} el ${new Date(VIG.creado).toLocaleString("es-VE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` +
    (VIG.dif_usd_pct != null ? ` · ${VIG.dif_usd_pct >= 0 ? "+" : ""}${nf(VIG.dif_usd_pct)} % sobre la oficial` : "") + "</span>";
}

/**
 * Monta el botón "Cambiar la tasa (con PIN)" y su panel dentro de `cont`.
 * opts: { url, key, app: 'caja'|'caja_admin', onCambio(vigente) }
 */
export function montarCambioTasa(cont, opts) {
  if (!cont) return;
  cont.innerHTML = `
    <p data-t="info" style="font-size:11.5px;color:#374151;margin:8px 0 0;line-height:1.45"></p>
    <button data-t="abrir" type="button" style="margin-top:8px;width:100%;padding:9px;border:2px solid #facc15;color:#854d0e;background:#fff;border-radius:10px;font-weight:700;font-size:14px">🔐 Cambiar la tasa (con PIN)</button>
    <div data-t="panel" style="display:none;margin-top:8px;padding:10px;background:#fefce8;border:1px solid #fde047;border-radius:10px">
      <p style="font-size:11.5px;color:#374151;margin:0 0 6px">Escribe cuántos <b>bolívares</b> vale cada moneda. Queda registrada con tu nombre, fecha y hora. Los cierres ya enviados no cambian.</p>
      <p style="font-size:12px;font-weight:700;color:#854d0e;margin:4px 0">✅ Paralela — la que usamos en todas las apps</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <label style="font-size:11.5px">1 R$ = Bs<input data-t="rs" type="number" step="any" inputmode="decimal" style="width:100%;padding:7px;border:1px solid #d1d5db;border-radius:8px;font-family:monospace;font-size:15px"></label>
        <label style="font-size:11.5px">1 USD = Bs<input data-t="usd" type="number" step="any" inputmode="decimal" style="width:100%;padding:7px;border:1px solid #d1d5db;border-radius:8px;font-family:monospace;font-size:15px"></label>
      </div>
      <p style="font-size:12px;font-weight:700;color:#6b7280;margin:10px 0 4px">📋 Oficial BCV — solo referencia (opcional)</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <label style="font-size:11.5px;color:#6b7280">1 R$ = Bs<input data-t="ors" type="number" step="any" inputmode="decimal" placeholder="opcional" style="width:100%;padding:7px;border:1px solid #e5e7eb;border-radius:8px;font-family:monospace;font-size:15px;background:#f9fafb"></label>
        <label style="font-size:11.5px;color:#6b7280">1 USD = Bs<input data-t="ousd" type="number" step="any" inputmode="decimal" placeholder="opcional" style="width:100%;padding:7px;border:1px solid #e5e7eb;border-radius:8px;font-family:monospace;font-size:15px;background:#f9fafb"></label>
      </div>
      <p data-t="calc" style="font-size:11.5px;color:#4b5563;margin:6px 0 0"></p>
      <input data-t="pin" type="password" inputmode="numeric" maxlength="10" placeholder="Tu PIN personal" style="width:100%;padding:9px;border:1px solid #d1d5db;border-radius:8px;margin-top:8px;text-align:center;font-size:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
        <button data-t="cancelar" type="button" style="padding:9px;border:1px solid #d1d5db;border-radius:8px;background:#fff">Cancelar</button>
        <button data-t="guardar" type="button" style="padding:9px;border:0;border-radius:8px;background:#ca8a04;color:#fff;font-weight:700">Guardar tasa</button>
      </div>
      <p data-t="msg" style="font-size:12px;margin:6px 0 0"></p>
    </div>`;
  const q = (t) => cont.querySelector(`[data-t="${t}"]`);
  const pintar = () => { q("info").innerHTML = textoVigente(); };
  const calc = () => {
    const u = parseFloat(q("usd").value), r = parseFloat(q("rs").value);
    const ou = parseFloat(q("ousd").value), or = parseFloat(q("ors").value);
    let t = (u > 0 && r > 0) ? `Paralela: 1 USD = <b>${nf(u / r, 2)} R$</b>` : "Escribe las dos tasas paralelas.";
    if (VIG && u > 0 && r > 0) t += `<br>Antes: 1 R$ = ${nf(VIG.paralelo_bs_rs)} Bs · 1 USD = ${nf(VIG.paralelo_bs_usd)} Bs`;
    if (or > 0 && r > 0) t += `<br>R$ paralela vs oficial: ${r - or >= 0 ? "+" : ""}${nf(r - or)} Bs (${nf((r / or - 1) * 100)} %)`;
    if (ou > 0 && u > 0) t += `<br>USD paralela vs oficial: ${u - ou >= 0 ? "+" : ""}${nf(u - ou)} Bs (${nf((u / ou - 1) * 100)} %)`;
    q("calc").innerHTML = t;
  };
  // Al escribir el R$ paralelo se propone el USD manteniendo la relación R$/USD vigente (se puede cambiar a mano).
  let usdTocado = false;
  const msg = (t, err) => { q("msg").textContent = t; q("msg").style.color = err ? "#b91c1c" : "#15803d"; };
  q("abrir").onclick = () => {
    q("panel").style.display = "block"; q("abrir").style.display = "none";
    usdTocado = false;
    if (VIG) {
      q("usd").value = VIG.paralelo_bs_usd; q("rs").value = VIG.paralelo_bs_rs;
      q("ousd").value = VIG.oficial_bs_usd > 0 ? VIG.oficial_bs_usd : ""; q("ors").value = VIG.oficial_bs_rs > 0 ? VIG.oficial_bs_rs : "";
    }
    calc(); msg(""); q("rs").focus();
  };
  q("cancelar").onclick = () => { q("panel").style.display = "none"; q("abrir").style.display = "block"; q("pin").value = ""; };
  q("usd").oninput = () => { usdTocado = true; calc(); };
  q("rs").oninput = () => {
    const r = parseFloat(q("rs").value), k = VIG && Number(VIG.rs_por_usd) > 0 ? Number(VIG.rs_por_usd) : null;
    if (!usdTocado && k && r > 0) q("usd").value = Math.round(r * k * 100) / 100;
    calc();
  };
  q("ousd").oninput = calc; q("ors").oninput = calc;
  q("guardar").onclick = async () => {
    const u = parseFloat(q("usd").value), r = parseFloat(q("rs").value), pin = q("pin").value.trim();
    const ou = parseFloat(q("ousd").value), or = parseFloat(q("ors").value);
    if (!(u > 0) || !(r > 0)) return msg("Escribe las dos tasas paralelas.", true);
    if (!/^[0-9]{4,10}$/.test(pin)) return msg("Escribe tu PIN personal.", true);
    if (!navigator.onLine) return msg("📵 Sin señal: para cambiar la tasa hace falta internet.", true);
    if (!confirm(`¿Guardar la tasa nueva?\n\nPARALELA (la que usamos)\n1 R$ = ${nf(r)} Bs\n1 USD = ${nf(u)} Bs\n(1 USD = ${nf(u / r, 2)} R$)\n\nOFICIAL (referencia)\n1 R$ = ${or > 0 ? nf(or) + " Bs" : "—"}\n1 USD = ${ou > 0 ? nf(ou) + " Bs" : "—"}\n\nLa usarán todas las apps desde ahora.`)) return;
    q("guardar").disabled = true; msg("Guardando…");
    try {
      _pub = _pub || createClient(opts.url, opts.key);
      const { data, error } = await _pub.rpc("tasa_cambiar", { p_pin: pin, p_app: opts.app, p_paralelo_bs_usd: u, p_paralelo_bs_rs: r,
        p_oficial_bs_usd: ou > 0 ? ou : null, p_oficial_bs_rs: or > 0 ? or : null });
      if (error) throw error;
      VIG = data; try { localStorage.setItem(COPIA, JSON.stringify(data)); } catch (e) { /* */ }
      q("pin").value = ""; q("panel").style.display = "none"; q("abrir").style.display = "block";
      pintar(); msg("");
      if (opts.onCambio) opts.onCambio(data);
    } catch (e) {
      msg(/fetch|network|load failed/i.test(String(e && (e.message || e))) ? "📵 Sin señal: no se guardó." : "❌ " + (e.message || e), true);
    } finally { q("guardar").disabled = false; }
  };
  pintar();
  return { pintar };
}
