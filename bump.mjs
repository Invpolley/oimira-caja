#!/usr/bin/env node
// Sube la versión en TODOS los archivos que la llevan, de una sola vez.
//
// Por qué existe: la versión vivía en 6 lugares y se desincronizaba. Si sw.js no
// cambia, el navegador no detecta la versión nueva y los celulares quedan pegados
// en la vieja. Si el sello de app.js no cambia, la pantalla miente sobre qué corre.
//
//   node bump.mjs 2026-07-28.1     -> pone esa versión en todos
//   node bump.mjs                  -> solo verifica que estén todos iguales
import fs from 'node:fs';

const ARCHIVOS = ['sw.js','app.js','index.html','admin/sw.js','admin/app.js','admin/index.html'];
const RE = /2026-\d{2}-\d{2}\.\d+/g;
const nueva = process.argv[2];

if (nueva && !/^2026-\d{2}-\d{2}\.\d+$/.test(nueva)) {
  console.error('Formato esperado: AAAA-MM-DD.N   (ej. 2026-07-28.1)');
  process.exit(1);
}

let fallo = false;
const encontradas = {};

for (const f of ARCHIVOS) {
  if (!fs.existsSync(f)) { console.error(`  ✗ falta ${f}`); fallo = true; continue; }
  let s = fs.readFileSync(f, 'utf8');
  const vs = [...new Set(s.match(RE) || [])];
  if (!vs.length) { console.error(`  ✗ ${f}: no tiene sello de versión`); fallo = true; continue; }
  if (nueva) {
    s = s.replace(RE, nueva);
    fs.writeFileSync(f, s);
    encontradas[f] = [nueva];
  } else {
    encontradas[f] = vs;
  }
}

const todas = [...new Set(Object.values(encontradas).flat())];
for (const f of ARCHIVOS) {
  if (encontradas[f]) console.log(`  ${f.padEnd(18)} ${encontradas[f].join(', ')}`);
}

if (todas.length === 1 && !fallo) {
  console.log(`\n✅ Todos en ${todas[0]}` + (nueva ? ' — listo para desplegar.' : ''));
} else if (!fallo) {
  console.error(`\n❌ Versiones distintas: ${todas.join(' / ')}`);
  console.error('   Corregí con: node bump.mjs ' + todas.sort().pop());
  process.exit(1);
} else {
  process.exit(1);
}
