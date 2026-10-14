/* OiMira — fechas siempre DÍA/MES/AÑO en los <input type="date">, sin importar el idioma del navegador.
   Chrome dibuja el campo según el idioma del navegador (en inglés sale mm/dd/yyyy). Este archivo oculta ese texto
   y muestra encima el valor en dd/mm/aaaa; el calendario y el valor real (ISO yyyy-mm-dd) no cambian. */
(function(){
  if(window.__fechaDMY) return; window.__fechaDMY = true;
  var css = 'input[type="date"]{position:relative;min-height:1.2em;display:inline-flex;align-items:center}' +
    'input[type="date"]::-webkit-datetime-edit{display:none}' +
    'input[type="date"]::before{content:attr(data-dmy);pointer-events:none;flex:1}' +
    'input[type="date"]:not([data-dmy])::before,input[type="date"][data-dmy=""]::before{content:"dd/mm/aaaa";opacity:.55}' +
    'input[type="date"]::-webkit-calendar-picker-indicator{margin-left:auto}';
  var st = document.createElement('style'); st.id = 'fecha-dmy-css'; st.textContent = css;
  (document.head || document.documentElement).appendChild(st);
  function fmt(v){ var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || ''); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function pintar(el){ var t = fmt(el.value); if(el.getAttribute('data-dmy') !== t) el.setAttribute('data-dmy', t); }
  function todos(){ var l = document.querySelectorAll('input[type="date"]'); for(var i = 0; i < l.length; i++) pintar(l[i]); }
  document.addEventListener('input', function(e){ if(e.target && e.target.type === 'date') pintar(e.target); }, true);
  document.addEventListener('change', function(e){ if(e.target && e.target.type === 'date') pintar(e.target); }, true);
  if(window.MutationObserver){ new MutationObserver(function(){ todos(); }).observe(document.documentElement, {childList:true, subtree:true}); }
  setInterval(todos, 700); // por si el valor se cambia por código (input.value = …) sin evento
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', todos); else todos();
})();
