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
exports.name = name;
exports.SIN_INTERNET = SIN_INTERNET;
exports.launch = (opts) => {
  if (!ENGINES.includes(name)) throw new Error('BROWSER=' + name + ' no es un motor válido (' + ENGINES.join(' | ') + ')');
  return pw[name].launch(Object.assign({ proxy: SIN_INTERNET }, opts));
};
