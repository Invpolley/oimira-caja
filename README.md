# 🥖 OiMira Caja — PWA de Cierre Diario

App web progresiva (PWA) para que la cajera de OiMira Panadería & Deli llene el cierre del día desde su celular. Reemplaza el libro manuscrito.

**URL de producción:** https://invjpolley.github.io/oimira-caja/ *(pendiente deploy)*

## ✨ Features

- 📱 **PWA instalable** — se agrega como app al celular (Android + iOS)
- 🔌 **Funciona offline** — IndexedDB local, sincroniza cuando hay internet
- 💰 **Multi-moneda** — R$ (Reales Brasil) y Bs (Bolívares Venezuela)
- 🔧 **Categorías personalizables** — cajera agrega nuevas formas de pago y categorías de gastos
- 📊 **Totales automáticos** — calcula en vivo Ingresos, Gastos, Neto
- ☁️ **Supabase backend** — base de datos Postgres + API REST gratis
- 🔒 **Keys públicas seguras** — Row Level Security en DB

## 🏗️ Stack

- Frontend: HTML + Tailwind CSS (CDN) + JS vanilla (ES modules)
- Backend: Supabase (`ilotlgspskcqcjpnccix.supabase.co`, región São Paulo)
- Hosting: GitHub Pages
- Offline: Service Worker + IndexedDB

## 🚀 Deploy en GitHub Pages

1. Crear repo público en GitHub: `oimira-caja`
2. Subir estos archivos a la rama `main`
3. Settings → Pages → Source: "Deploy from a branch" → main → `/ (root)`
4. Esperar ~1 min → URL: `https://<usuario>.github.io/oimira-caja/`

```bash
git init
git add .
git commit -m "Initial commit: OiMira Caja PWA"
git branch -M main
git remote add origin https://github.com/invjpolley/oimira-caja.git
git push -u origin main
```

## 📱 Instalar en celular

- **Android (Chrome):** Menú → "Agregar a pantalla de inicio"
- **iOS (Safari):** Compartir → "Agregar a pantalla de inicio"

## 🗄️ Estructura de la base de datos

```sql
dia_cierre          -- Cierre del día (uno por fecha)
forma_pago_extra    -- Formas de pago custom (iFood, Zelle, etc)
dia_gasto           -- Gastos/entregas del día
categoria_gasto     -- Catálogo de categorías (Personal, Servicios, etc.)
forma_pago_catalogo -- Catálogo de formas de pago
```

Vista útil: `dia_cierre_resumen` con totales calculados.

## 🔄 Sync con libro_ventas.xlsx

Desde tu PC, corré:

```powershell
cd C:\Users\invjp\Documents\inversionespolley
python supabase_sync.py
```

Esto descarga todos los cierres de Supabase y los appendea al Excel.

## 🎨 Customización

- **Colores**: edita las clases Tailwind en `index.html`
- **Cajeras**: edita las opciones del select en `index.html`
- **Categorías**: modifica directamente en Supabase Dashboard o vía SQL
