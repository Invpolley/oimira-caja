# 🚀 Deploy a GitHub Pages — Paso a paso

## 1. Crear repo en GitHub

1. Andá a https://github.com/new
2. Repository name: `oimira-caja`
3. Visibility: **Public** (requerido para GitHub Pages gratis)
4. **NO** marques "Add README" (ya lo tenemos)
5. Click "Create repository"

## 2. Subir los archivos desde Windows

Abrí PowerShell en `C:\Users\invjp\Documents\inversionespolley\oimira-caja\` y corré:

```powershell
cd C:\Users\invjp\Documents\inversionespolley\oimira-caja
git init
git add .
git commit -m "Initial commit: OiMira Caja PWA"
git branch -M main
git remote add origin https://github.com/invjpolley/oimira-caja.git
git push -u origin main
```

Te va a pedir login a GitHub (usuario + Personal Access Token).

## 3. Activar GitHub Pages

1. En tu repo en GitHub: **Settings** (arriba derecha)
2. Sidebar: **Pages**
3. "Build and deployment" → Source: **Deploy from a branch**
4. Branch: **main** + folder: **/ (root)**
5. **Save**
6. Esperar ~1 minuto

Tu app va a estar live en:
```
https://invjpolley.github.io/oimira-caja/
```

## 4. Instalar en el celular de la cajera

### Android (Chrome)
1. Abrir la URL
2. Menú (3 puntos) → "Agregar a pantalla de inicio"
3. Nombre: "OiMira Caja" → Agregar

### iPhone (Safari)
1. Abrir la URL
2. Botón Compartir (cuadrado con flecha)
3. "Agregar a pantalla de inicio"
4. Agregar

Se instala como **app nativa** con icono OiMira naranja 🥖.

## 5. Uso diario

La cajera:
1. Abre la app (pantalla de inicio)
2. Llena los campos del día
3. Agrega gastos/entregas si hay
4. Toca "Enviar cierre del día"
5. Listo — se sincroniza automático a Supabase

Vos desde tu PC:
```powershell
cd C:\Users\invjp\Documents\inversionespolley
python supabase_sync.py       # baja cierres al libro_ventas.xlsx
```

## 6. Ver los cierres directamente en Supabase

Dashboard: https://supabase.com/dashboard/project/ilotlgspskcqcjpnccix

Ahí podés:
- Ver la tabla `dia_cierre` con todos los cierres
- Editar manualmente si hay un error
- Agregar/modificar categorías de gastos
- Exportar a CSV

## 🔧 Troubleshooting

**"La app muestra 'Offline' pero tengo internet"**
- Refrescar la página (Ctrl+R / F5)
- Comprobar que la URL tenga `https://`

**"No se envía el cierre"**
- El borrador queda guardado localmente
- Cuando haya internet, reabrir la app y tocar "Enviar"
- Si persiste, avísame

**"Quiero agregar otra cajera"**
- Editar en `index.html` el `<select id="cajera">` agregando `<option>`
- O usar "Otra..." y escribir el nombre

**"Cambié el código, ¿cómo actualizo?"**
```powershell
git add .
git commit -m "Update: descripción del cambio"
git push
```
GitHub Pages redeploys automático en ~1 min.
