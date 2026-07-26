// Configuración Supabase — OiMira Caja
// Estas keys son PÚBLICAS (anon/publishable) y seguras para exponer en el frontend.
// La seguridad viene de las Row Level Security policies en la base de datos.

// Migrado al proyecto central oimiraonline · esquema oimira_caja (2026-06-14)
export const SUPABASE_URL = "https://pjanwmwuzkmjawcjpjtx.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_Af20dNnlmYwC4n_xLfkYGg_WsxyWApK";

// Nombre de la cajera por defecto (modificable en la UI)
// La selección actual se guarda en localStorage key "oimira_cajera"
export const CAJERA_DEFAULT = "Patricia";

// Nombre del dispositivo (se llena automático en PWA)
export const DEVICE_NAME = navigator.userAgent.includes("Mobile") ? "Móvil" : "PC";
