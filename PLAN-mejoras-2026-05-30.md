# 🛠️ Plan de mejoras OiMira Caja + Admin — 2026-05-30

> Documento de planificación. **Nada de esto se implementó todavía** — es para que lo revises y apruebes antes de tocar código de producción (la cajera usa la app a diario y la BD tiene 42 cierres reales).

---

## 1. Estado actual del proyecto (review)

### Arquitectura confirmada

| Pieza | Detalle |
|-------|---------|
| Repo | `github.com/Invpolley/oimira-caja` (GitHub Pages) |
| Módulo **Caja** (raíz) | PWA cajera: HTML + Tailwind CDN + JS vanilla ESM, offline con IndexedDB, sync a Supabase |
| Módulo **Admin** (`/admin`) | Panel dueño: KPIs, gráfico Chart.js, reconciliación de saldos, retiros, generación de códigos de unlock |
| Backend | Supabase `ilotlgspskcqcjpnccix` (São Paulo), RLS activo en las 8 tablas |
| Auth actual | Caja: sin login. Admin: PIN `2468` (12 h en localStorage) — barrera de UX, no seguridad real |

### Tablas existentes

`dia_cierre` (42) · `forma_pago_extra` (3) · `dia_gasto` (247) · `categoria_gasto` (6) · `forma_pago_catalogo` (6) · `caja_saldo` (41) · `caja_retiro` (20) · `admin_unlock_code` (8).

**Sacos de trigo hoy:** una sola columna `dia_cierre.sacos_trigo` (integer). Sin desglose por tipo ni peso.

### Lo que está bien hecho ✅

- **Multi-moneda con tasas inmutables por día** (`tasa_bs_rs`, `tasa_usd_rs` se guardan con cada cierre y no se recalculan).
- **Resiliencia offline real**: IndexedDB + fallback hardcoded de catálogos para que la UI nunca quede sin inputs.
- **Fechas locales** (`todayLocalISO()`) en vez de UTC — evita el salto de día de noche.
- **Flujo de cierre con confirmación** + lock por `transmitted_at` + unlock atómico vía RPC `consume_unlock_code`.
- **Escapado de HTML** (`escapeHtml`) en todo lo que se inyecta — buena higiene contra XSS.

### Riesgos / deudas técnicas detectadas ⚠️

1. **Keys y PIN en código fuente público** (`config.js`). El PIN admin viaja en el bundle. La seguridad real depende 100% de las RLS de Supabase. Hay que confirmar que las RLS no permitan que un `anon` lea/borre lo que no debe.
2. **Caja sin identidad**: cualquiera con la URL puede escribir cierres. Hoy se mitiga con el lock, pero no hay control de quién es la cajera más allá de un `<select>`.
3. **Cajeras hardcodeadas** en el `<select>` de `index.html` — no hay catálogo en BD (a diferencia de formas de pago y categorías).
4. **`prompt()` para agregar formas de pago/cajeras** — UX pobre en móvil y sin validación.
5. **No hay tabla de configuración** — todo cambio de comportamiento (ocultar USD, cambiar colores) requiere tocar código y re-deploy.
6. **Sin enmascaramiento de datos sensibles** (saldos, montos) — el panel admin muestra todo en claro siempre.

---

## 2. Feature A — Conteo detallado de sacos de trigo

**Decisión tuya:** cada registro = **tipo × peso × cantidad** (patrón tipo "gastos", filas que la cajera agrega).

### 2.1 Cambios en base de datos (DDL nuevo, no destructivo)

```sql
-- Catálogo de tipos de saco (editable desde admin)
create table saco_tipo (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,          -- "Azul", "Rojo", "Trigo especial"
  color  text default '#3b82f6',        -- color visual del chip
  orden  integer default 0,
  activo boolean default true,
  created_at timestamptz default now()
);

-- Catálogo de pesos disponibles (editable desde admin)
create table saco_peso (
  id uuid primary key default gen_random_uuid(),
  kg     numeric not null,              -- 50, 45, 25...
  label  text,                          -- "50 kg" (opcional, se deriva)
  orden  integer default 0,
  activo boolean default true,
  created_at timestamptz default now(),
  unique (kg)
);

-- Detalle de sacos consumidos por día (tabla hija de dia_cierre)
create table dia_saco (
  id uuid primary key default gen_random_uuid(),
  dia_cierre_id uuid references dia_cierre(id) on delete cascade,
  tipo   text not null,                 -- snapshot del nombre (como dia_gasto.categoria)
  kg     numeric not null,              -- snapshot del peso
  cantidad integer not null default 0,
  created_at timestamptz default now()
);
```

- **`dia_cierre.sacos_trigo` se mantiene** como total derivado (suma de cantidades) para no romper el admin actual ni los 42 cierres históricos. Se sigue escribiendo, pero ahora calculado.
- Seeds iniciales: tipos `Azul`, `Rojo`, `Trigo especial`; pesos `50`, `45`.
- RLS: mismas policies que `categoria_gasto`/`dia_gasto` (lectura pública, escritura anon controlada).

### 2.2 Cambios en Caja (UI)

Nueva sección **"🌾 Sacos de trigo"** que reemplaza el input único. Funciona como la lista de gastos:

- Botón **"+ Agregar saco"** → fila con: select Tipo (chips de color del catálogo) · select Peso · input Cantidad.
- Total en vivo: *"Hoy: 6 sacos · 290 kg"* desglosado (3 azul 50kg, 2 rojo 45kg…).
- Se guarda en `dia_saco` con el mismo patrón delete+reinsert que ya usa `enviarCierre()` para gastos.
- `state.sacosTrigo` pasa de número a `state.sacos = [{tipo, kg, cantidad}]`; el total entero se deriva al enviar.

### 2.3 Cambios en Admin (reporte)

- Card nueva: **consumo de trigo del período** por tipo y por kg total.
- Modo de gráfico extra: kg de trigo por día / por tipo.
- Export CSV incluye columnas de sacos detallados.

### Guía de Proceso Interno — Sacos (cajera)
1. En el cierre del día, bajar a la sección **🌾 Sacos de trigo**.
2. Tocar **+ Agregar saco**.
3. Elegir el color del saco (Azul / Rojo / Especial), el peso (50 / 45 kg) y escribir cuántos se usaron.
4. Repetir por cada combinación distinta. El total de kg se calcula solo.
5. Enviar el cierre normalmente — los sacos viajan junto al resto.

---

## 3. Feature B — Rol administrativo que controla ambos módulos

**Decisión tuya:** las 4 capacidades (toggles de UI · gestión de catálogos · login/acceso · branding). Lo propongo en una **nueva sección `/admin/config`** dentro del panel admin, en fases.

### 3.1 Tabla de configuración central (habilita todo)

```sql
create table app_config (
  clave text primary key,        -- 'show_usd', 'show_sacos', 'brand_color', 'logo_url'...
  valor jsonb not null,          -- true / "#DA020E" / "https://..."
  modulo text default 'ambos',   -- 'caja' | 'admin' | 'ambos'
  actualizado_at timestamptz default now(),
  actualizado_por text
);
```

Caja y Admin leen `app_config` al boot (con fallback a defaults hardcoded si falla el fetch, igual que los catálogos hoy).

### 3.2 (a) Activar/ocultar campos y secciones
Pantalla con switches: mostrar/ocultar USD, Bs, sacos, tickets, observaciones; reordenar secciones. Cada switch escribe una clave en `app_config`. La Caja respeta esas claves al renderizar.

### 3.3 (b) Gestión de catálogos (CRUD sin SQL)
Pantallas para crear/editar/desactivar: **cajeras** (tabla nueva `cajera`, hoy hardcodeada), formas de pago, categorías de gasto, tipos y pesos de saco. Reemplaza los `prompt()` y la edición manual en Supabase.

### 3.4 (c) Control de acceso / login
- Tabla `usuario_admin` (rol: `dueño` | `administrativo`, hash de contraseña SHA-256, email de recuperación) — mismo patrón que ya documenté del ecosistema oimira.com.
- **Roles:** `dueño` ve y edita todo (incluye config y saldos); `administrativo` ve operación y catálogos pero **no** saldos/retiros ni cambia el dueño.
- ⚠️ **Nota de seguridad honesta:** como el JS es público, esto es control de *acceso a la UI*, no seguridad criptográfica. La frontera real son las **RLS de Supabase**. Para seguridad fuerte de verdad habría que migrar a Supabase Auth (magic-link/email) — lo dejo como fase opcional.

### 3.5 (d) Branding / colores
Claves en `app_config`: `logo_url`, `brand_primary`, `brand_gold`, `nombre_local`, textos de cabecera. Ambas PWAs los aplican como CSS variables al cargar.

### Guía de Proceso Interno — Panel administrativo (dueño)
1. Entrar a `/admin` con tu contraseña.
2. Ir a **⚙️ Configuración**.
3. **Pantallas/Campos:** prender o apagar lo que ve la cajera (ej. apagar USD si hoy no se usa).
4. **Catálogos:** agregar una cajera nueva, una forma de pago, un tipo de saco — se reflejan al instante en la Caja.
5. **Usuarios:** crear un acceso "administrativo" con su contraseña y definir qué puede tocar.
6. **Marca:** cambiar logo y colores; confirmar con la vista previa antes de guardar.

---

## 4. Ideas de mejora priorizadas (más allá de lo pedido)

### 🔴 Alto impacto / seguridad
- **Auditar las RLS de Supabase** — confirmar que `anon` no pueda borrar `dia_cierre` ni leer datos de saldos sin pasar por las reglas. Es la única seguridad real.
- **Enmascaramiento de saldos** en admin (mostrar `••••` con botón "ojo" para revelar) — pedido por el perfil FinTech del proyecto.
- **Validación de coherencia al cerrar**: avisar si el efectivo que queda es negativo, si faltan tasas con montos cargados, o si un día se cierra con totales en 0.

### 🟡 Funcionalidad
- **Editar un cierre desde el admin** (fix rápido sin código) — ya está en tu lista de "Futuros".
- **Alerta de días sin cierre** (gaps en el calendario).
- **Comparativo semana vs semana anterior** y promedios.
- **Export a Excel `.xlsx`** con formato (hoy es CSV).
- **Alerta de stock de trigo**: con el conteo nuevo, avisar "quedan pocos sacos" según un umbral configurable.

### 🟢 UX / calidad
- Reemplazar `prompt()` por modales con validación.
- Catálogo de cajeras en BD (quitar el hardcode del select).
- Accesibilidad: foco visible, labels ARIA, contraste (hay un skill de accesibilidad disponible).
- Botón "duplicar cierre de ayer" como punto de partida.
- PWA: revisar estrategia del service worker para que no sirva JS viejo tras un deploy (cache-busting por versión).

---

## 5. Orden de implementación sugerido (fases)

| Fase | Qué | Riesgo | Por qué primero |
|------|-----|--------|-----------------|
| **0** | Auditar RLS + backup de la BD | — | No tocar producción sin red de seguridad |
| **1** | Feature A: sacos detallados (DDL + Caja + Admin) | Bajo | Es aditivo, no rompe lo existente; valor inmediato |
| **2** | `app_config` + toggles de UI (3.1, 3.2) | Bajo | Base para todo lo demás |
| **3** | Gestión de catálogos + tabla cajeras (3.3) | Medio | Quita fricción operativa |
| **4** | Login/roles administrativo (3.4) | Medio | Requiere decidir nivel de seguridad |
| **5** | Branding (3.5) + mejoras UX | Bajo | Cosmético, al final |

---

## 6. Decisiones que necesito confirmar antes de la Fase 1

1. **Pesos de saco iniciales**: ¿`50` y `45` kg, o agrego más (25, 10)?
2. **Tipos iniciales**: ¿`Azul`, `Rojo`, `Trigo especial` o hay otros?
3. **¿Aplico la migración directo en producción** o creo un branch de Supabase para probar primero?
4. **Login administrativo**: ¿contraseña simple estilo el PIN actual, o querés que migremos a Supabase Auth de verdad (más trabajo, más seguro)?

---

*Generado 2026-05-30 · Pendiente de aprobación de Polley · Se respetan las reglas del vault polleyMemory (decisiones se documentarán en Decision log al implementar).*
