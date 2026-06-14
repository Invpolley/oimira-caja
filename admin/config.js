// Configuración Supabase — OiMira Admin
// Estas keys son PÚBLICAS (anon/publishable) y seguras para exponer en el frontend.
// La seguridad viene de las Row Level Security policies en la base de datos.

export const SUPABASE_URL = "https://pjanwmwuzkmjawcjpjtx.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_Af20dNnlmYwC4n_xLfkYGg_WsxyWApK";

// PIN de admin (cambialo cuando quieras — es solo protección básica)
// No es seguridad real (el JS es público), sino una barrera para que
// la cajera u otros no entren por accidente.
export const ADMIN_PIN = "2468";
