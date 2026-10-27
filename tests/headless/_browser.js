// Motor del navegador para las suites headless: BROWSER=chromium (por defecto) | webkit | firefox.
// Las suites llaman launch(opts) en vez de chromium.launch(opts); run_all.sh deja pasar BROWSER tal cual
// (`npm run webkit` corre las suites del iPad en WebKit, el motor de Safari). Un motor que no esté
// instalado falla al lanzar con el mensaje de Playwright (`npx playwright install webkit`).
const pw = require('playwright');
const ENGINES = ['chromium', 'webkit', 'firefox'];
const name = String(process.env.BROWSER || 'chromium').trim().toLowerCase();
// Nada sale a internet (20 oct 2026): en app_offline, con la página controlada por el service worker, Chromium mandaba
// el preflight CORS (OPTIONS /rest/v1/patients) al Supabase REAL —Playwright no lo intercepta y context.route no lo ve— y
// el servidor contestaba 200. Todo lo que no sea 127.0.0.1/localhost va a un proxy muerto (puerto 9): las rutas de las
// suites siguen atendiendo lo suyo (antes del proxy) y lo que se escape falla sin salir de la máquina. Una suite que
// pase su propio `proxy` en opts lo cambia.
const SIN_INTERNET = { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost,[::1]' };
// Toques sintéticos que sirven en los dos motores (21 oct 2026): WebKit (el de Safari) no deja construir `new Touch({…})`
// («TypeError: Illegal constructor») y su TouchEvent solo acepta TouchList, no arreglos; a cambio tiene los de iOS,
// document.createTouch (en coordenadas de página) y document.createTouchList. Chromium es al revés. Se inyecta con
// page.addInitScript(touchHelpers) y en la página quedan:
//   __plTouch(el, x, y, id)                → Touch con clientX/clientY = x/y sobre el
//   __plTouchEvent(type, touches, changed) → TouchEvent que burbujea y se puede cancelar (targetTouches = touches)
const touchHelpers = () => {
  const ios = () => typeof document.createTouch === 'function' && typeof document.createTouchList === 'function';
  window.__plTouch = (el, x, y, id) => ios()
    ? document.createTouch(window, el, id || 1, x + window.scrollX, y + window.scrollY, x, y)
    : new Touch({ identifier: id || 1, target: el, clientX: x, clientY: y });
  const list = (a) => ios() ? document.createTouchList(...a) : a;
  window.__plTouchEvent = (type, touches, changed) => new TouchEvent(type, { bubbles: true, cancelable: true, touches: list(touches), targetTouches: list(touches), changedTouches: list(changed) });
};
exports.name = name;
exports.SIN_INTERNET = SIN_INTERNET;
exports.touchHelpers = touchHelpers;
exports.launch = (opts) => {
  if (!ENGINES.includes(name)) throw new Error('BROWSER=' + name + ' no es un motor válido (' + ENGINES.join(' | ') + ')');
  return pw[name].launch(Object.assign({ proxy: SIN_INTERNET }, opts));
};
