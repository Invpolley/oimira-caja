# 🚀 Deploy OiMira Admin — Paso a paso

## Opción recomendada — subfolder dentro de `oimira-caja`

Así usás **un solo repo** y la cajera y el admin quedan en la misma URL base:

- Cajera: `https://Invpolley.github.io/oimira-caja/`
- Admin:  `https://Invpolley.github.io/oimira-caja/admin/`

### 1. Mover `oimira-admin/` dentro del repo

Abrí **PowerShell** y corré:

```powershell
cd C:\Users\invjp\Documents\inversionespolley\oimira-caja

# Crear carpeta admin y copiar los archivos
mkdir admin -Force
Copy-Item -Path "..\oimira-admin\*" -Destination ".\admin\" -Recurse -Force

# Ver qué se movió
ls admin
```

### 2. Commit + push

```powershell
git add admin
git commit -m "Add admin dashboard for reviewing daily cierres"
git push
```

GitHub Pages redeploys solo en ~1 min. Probá:

```
https://Invpolley.github.io/oimira-caja/admin/
```

### 3. Primer ingreso

1. Abrí la URL
2. Ingresá el PIN: **2468** (está en `admin/config.js` — cambialo cuando quieras)
3. Ya ves los cierres que la cajera mandó desde la PWA

### 4. Instalar como app

- **PC Chrome/Edge:** click en el ícono de "instalar" en la barra de URL → "OiMira Admin"
- **Celu:** Menú → "Agregar a pantalla de inicio"

## Opción B — Repo separado

Si preferís separarlo completamente:

```powershell
cd C:\Users\invjp\Documents\inversionespolley\oimira-admin
git init
git add .
git commit -m "Initial commit: OiMira Admin"
git branch -M main
gh repo create oimira-admin --public --source=. --remote=origin --push --description "Panel admin para revisar cierres de OiMira"
```

Después en `https://github.com/Invpolley/oimira-admin/settings/pages` elegí:
- Source: Deploy from a branch
- Branch: main / (root)
- Save

URL: `https://Invpolley.github.io/oimira-admin/`

## 🔐 Cambiar PIN

Editá `config.js`:

```js
export const ADMIN_PIN = "2468"; // cambiá acá
```

Commit + push. Usuarios actuales deben re-loguear cuando expire la sesión de 12h.

## 🔄 Flujo diario

```
Cajera (celular)          Polley (PC o celular)
━━━━━━━━━━━━━━━━         ━━━━━━━━━━━━━━━━━━━━━
OiMira Caja PWA     →    OiMira Admin
├─ Llena cierre    →     ├─ Ve todos los días
├─ Gastos          →     ├─ KPIs + gráfico
└─ Envía a Supabase →    ├─ Detalle por día
                          ├─ Por cajera
                          ├─ Por categoría
                          └─ Export CSV

            ↓
Polley desde PC:
python supabase_sync.py
→ libro_ventas.xlsx se actualiza
```

## 🐛 Troubleshooting

**"Error al cargar — no veo cierres"**
- Verificá que la cajera haya enviado al menos uno (revisá en Supabase Dashboard)
- Refrescá (Ctrl+R / F5)
- Revisá el rango de fechas

**"El PIN no funciona"**
- Revisá que en `config.js` el valor coincida con lo que tecleás
- Si cambiaste el PIN, hacé `git push` y esperá ~1min a que GitHub Pages redeploy

**"El gráfico está vacío"**
- Solo se renderiza si hay cierres en el rango. Ampliá el rango (90d).

**"Quiero editar un cierre con error"**
- Por ahora editá directo en Supabase Dashboard → Table editor → `dia_cierre`
- En el futuro lo agregamos al admin
