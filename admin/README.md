# 📊 OiMira Admin — Panel de Cierres

Panel administrativo para que **Polley (dueño)** revise los cierres diarios que la cajera envía desde `oimira-caja`.

Mismo stack, mismo estilo, misma base Supabase — solo lectura + agregaciones.

## ✨ Features

- 🔐 **Gate por PIN** — la cajera no entra aquí (PIN se guarda 12h en el navegador)
- 📅 **Filtro por rango** — hoy, 7d, 30d, 90d, o custom
- 📊 **KPIs en vivo** — totales R$ / Bs, gastos, días cerrados
- 📈 **Gráfico Chart.js** — 3 modos (Ingresos / Neto / Trigo+Tickets)
- 📋 **Lista expandible** — click en un día para ver todos los gastos + formas de pago
- 👥 **Breakdown por cajera** — quién vendió cuánto
- 💸 **Breakdown por categoría de gasto** — a dónde se va la plata
- ⬇ **Export CSV** — con BOM UTF-8 para abrir perfecto en Excel
- 📱 **PWA instalable** — funciona en celu y PC

## 🚀 Deploy

### Opción A — Mismo repo que `oimira-caja` (subfolder)

Copiá la carpeta `oimira-admin/` dentro del repo `oimira-caja` y pushá:

```powershell
cd C:\Users\invjp\Documents\inversionespolley\oimira-caja
# (ya tenés oimira-admin/ al lado; moverla dentro)
mkdir admin
cp -r ..\oimira-admin\* admin\
git add admin
git commit -m "Add admin dashboard"
git push
```

URL: `https://Invpolley.github.io/oimira-caja/admin/`

### Opción B — Repo separado `oimira-admin`

```powershell
cd C:\Users\invjp\Documents\inversionespolley\oimira-admin
git init
git add .
git commit -m "Initial commit: OiMira Admin"
git branch -M main
gh repo create oimira-admin --public --source=. --remote=origin --push
```

Después en GitHub → Settings → Pages → Branch: main → / (root) → Save.

URL: `https://Invpolley.github.io/oimira-admin/`

## 🔐 Cambiar el PIN

Abrí `config.js` y cambiá `ADMIN_PIN`:

```js
export const ADMIN_PIN = "2468"; // ← cambialo a lo que quieras
```

Commit + push y listo. El PIN actual en el navegador expira en 12h automático.

**Nota importante:** el PIN es **protección básica**, no seguridad real. El código JS es público. Para seguridad fuerte usaríamos Supabase Auth (opcional a futuro).

## 📱 Instalar en celular / PC

- **Android Chrome:** Menú → "Agregar a pantalla de inicio"
- **iOS Safari:** Compartir → "Agregar a pantalla de inicio"
- **PC Chrome/Edge:** Ícono de instalar en la barra de URL

## 🗂️ Estructura

```
oimira-admin/
├── index.html      # UI (Tailwind + Chart.js CDN)
├── app.js          # Lógica: fetch, cálculos, render, export
├── config.js       # Supabase URL + anon key + PIN
├── manifest.json   # PWA manifest
├── sw.js           # Service worker (offline cache)
└── icons/          # Iconos de la app
```

## 🔄 Datos

Lee de las mismas tablas que la cajera escribe:

- `dia_cierre` — cierre del día
- `forma_pago_extra` — formas de pago custom (iFood, Zelle, etc)
- `dia_gasto` — gastos/entregas

Refresco automático cada 60s. Botón 🔄 para forzar.

## 🛠️ Futuros

- [ ] Editar un cierre desde el admin (fix rápido)
- [ ] Alerta de días sin cierre (gaps)
- [ ] Comparativo semana vs semana anterior
- [ ] Export a Excel (.xlsx) con formato
- [ ] Supabase Auth (email magic-link) en lugar de PIN
