// 🔄 Aviso de versión nueva (20 oct 2026): la app compara su PL_BUILD (index.html) con "v" de version.json (raíz del
// repo). Se publican tal cual (GitHub Pages sirve la raíz de main; Cloudflare y Netlify copian los dos a dist/), así que
// si no coinciden, TODOS los equipos verían «Hay una versión nueva» para siempre (o nunca, si se olvida subir la de
// version.json). Sin navegador.
//   node tests/headless/version_check.js [carpeta-del-repo]   (run_all.sh la corre con las demás suites)
const fs = require('fs'), path = require('path');
const REPO = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const decl = html.match(/const PL_BUILD = "([^"]*)";/g) || [];
const build = decl.length === 1 ? /"([^"]*)"/.exec(decl[0])[1] : null;
let ver = null, verErr = '';
try { ver = JSON.parse(fs.readFileSync(path.join(REPO, 'version.json'), 'utf8')); } catch (e) { verErr = String(e.message || e); }
check('V1 index.html declara PL_BUILD una sola vez (const PL_BUILD = "…") con un valor no vacío', decl.length === 1 && !!build, JSON.stringify(decl));
check('V2 version.json existe, es JSON y trae "v" no vacío', !!ver && typeof ver.v === 'string' && !!ver.v.trim(), verErr || JSON.stringify(ver));
check('V3 PL_BUILD de index.html es igual a "v" de version.json', !!build && !!ver && ver.v === build, JSON.stringify({ build, v: ver && ver.v }));
console.log('RESULT VERSION-CHECK: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
