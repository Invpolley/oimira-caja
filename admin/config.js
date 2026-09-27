// Configuración Supabase — OiMira Admin
// Estas keys son PÚBLICAS (anon/publishable) y seguras para exponer en el frontend.
// La seguridad viene de las Row Level Security policies en la base de datos.

// Migrado al proyecto central oimiraonline · esquema oimira_caja (2026-06-14)
export const SUPABASE_URL = "https://pjanwmwuzkmjawcjpjtx.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_Af20dNnlmYwC4n_xLfkYGg_WsxyWApK";

// 26/09/2026: ya NO hay PIN general. Cada persona entra con su PIN personal de Compras si tiene el permiso
// "Admin de cierres de caja" (o es dueño). Se administra en config.fitmassa.com → 👥 Accesos y PIN.
