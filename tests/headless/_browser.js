// Motor del navegador para las suites headless: BROWSER=chromium (por defecto) | webkit | firefox.
// Las suites llaman launch(opts) en vez de chromium.launch(opts); run_all.sh deja pasar BROWSER tal cual
// (`npm run webkit` corre las suites del iPad en WebKit, el motor de Safari). Un motor que no esté
// instalado falla al lanzar con el mensaje de Playwright (`npx playwright install webkit`).
const pw = require('playwright');
const ENGINES = ['chromium', 'webkit', 'firefox'];
const name = String(process.env.BROWSER || 'chromium').trim().toLowerCase();
exports.name = name;
exports.launch = (opts) => {
  if (!ENGINES.includes(name)) throw new Error('BROWSER=' + name + ' no es un motor válido (' + ENGINES.join(' | ') + ')');
  return pw[name].launch(opts);
};
