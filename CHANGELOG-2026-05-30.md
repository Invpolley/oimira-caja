# 🚀 Cambios 2026-05-30 — Sacos detallados + fix bug de medianoche

## 1. 🐛 Fix del bug de medianoche (la caja no cuadraba)

**Causa:** el código tomaba la fecha del **reloj del dispositivo** (`new Date().getDate()`). Si el celular/PC del admin no está en hora Venezuela (estaba en UTC/automático), entre las **8 PM y medianoche** registraba todo en el **día siguiente**.

**Evidencia real:** 6 retiros (R$ 21.538, 9.200, 7.218, 500, 50, 15.000) cargados de noche quedaron un día adelantado y rompieron la cadena de saldos.

**Solución:** la fecha de negocio ahora se ancla a `America/Caracas` (no depende del dispositivo), tanto en Caja como en Admin. Además se corrigió el default del servidor en `caja_retiro.fecha` y `caja_saldo.fecha` (estaba en UTC).

**Probado:** simulación (`outputs/sim/date_sim.mjs`) que reprodujo los 6 casos reales (6/6) y verificó que el fix los corrige todos.

## 2. 🌾 Sacos de trigo detallados (tipo × peso × cantidad)

- **Caja:** nueva sección donde la cajera agrega filas: tipo (Azul / Rojo / Trigo especial) × peso (50 / 45 kg) × cantidad, con total en vivo "X sacos · Y kg".
- **Admin:** reporte de consumo por tipo y kg del rango + **gestión de catálogo**: crear, activar/desactivar y borrar tipos y pesos sin tocar la base de datos.
- **BD:** nuevas tablas `saco_tipo`, `saco_peso`, `dia_saco` (ya aplicadas). El total sigue guardándose en `dia_cierre.sacos_trigo` para no romper lo viejo.
- **Probado:** simulación de totales + prueba end-to-end real contra Supabase (insertar/leer/cleanup), todo OK.

## ✅ Estado
- Base de datos: **migración aplicada y en vivo**.
- Código: listo y validado (sintaxis + simulaciones + E2E). Service workers bumpeados (caja v11, admin v12).
- **Falta:** desplegar el frontend → `git push` desde tu PC (GitHub Pages publica solo).

## ⚠️ Para decidir
Los **6 retiros históricos** que cayeron en el día equivocado siguen como están (no toco historial sin tu OK). Si querés, los corrijo a su fecha real para que la caja de esos días cuadre.

## ⏭️ Pendiente
**Rol administrativo completo** (login dueño/administrativo, mostrar/ocultar campos, branding) — es grande, lo dejamos para la próxima. Esta vez prioricé el bug + los sacos.
