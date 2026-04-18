// Configuración Supabase — OiMira Caja
// Estas keys son PÚBLICAS (anon/publishable) y seguras para exponer en el frontend.
// La seguridad viene de las Row Level Security policies en la base de datos.

export const SUPABASE_URL = "https://ilotlgspskcqcjpnccix.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_zCNn-xOyefwgj-QebLw6Kg_GdBm0xr-";

// Nombre de la cajera por defecto (modificable en la UI)
// La selección actual se guarda en localStorage key "oimira_cajera"
export const CAJERA_DEFAULT = "Patricia";

// Nombre del dispositivo (se llena automático en PWA)
export const DEVICE_NAME = navigator.userAgent.includes("Mobile") ? "Móvil" : "PC";
