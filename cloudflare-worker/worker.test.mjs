// Pruebas sin red del worker (27 oct 2026): rutas que disparan a los robots. fetch de GitHub simulado.
//   node cloudflare-worker/worker.test.mjs
import worker from "./index.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log("✓ " + n); } else { fail++; console.log("✗ " + n + (x ? " :: " + x : "")); } };
const ENV = { ACCESS_TOKEN: "tok", GEMINI_API_KEY: "g", GITHUB_TOKEN: "gh" };
let llamadas = [], corridas = [];
globalThis.fetch = async (url, init) => {
  const u = String(url); llamadas.push({ u, m: (init && init.method) || "GET", body: init && init.body ? JSON.parse(init.body) : null });
  if (/\/runs\?/.test(u)) return new Response(JSON.stringify({ workflow_runs: corridas }), { status: 200 });
  if (/\/dispatches$/.test(u)) return new Response(null, { status: 204 });
  if (/\/cancel$/.test(u)) return new Response(null, { status: 202 });
  return new Response("{}", { status: 404 });
};
const pedir = (ruta, body, token = "tok") => worker.fetch(new Request("https://w.ejemplo" + ruta, { method: "POST", headers: { "x-piso-token": token, "content-type": "application/json" }, body: JSON.stringify(body || {}) }), ENV);

{
  llamadas = []; corridas = [];
  const r = await pedir("/api/scrape-ris", { exp: "0012345" }); const d = await r.json();
  const disp = llamadas.find((c) => /dispatches$/.test(c.u));
  check("/api/scrape-ris dispara ris-scraper.yml en main, sin corrida dirigida (aunque llegue un exp)", r.status === 200 && d.dispatched === true && disp && /workflows\/ris-scraper\.yml\/dispatches$/.test(disp.u) && disp.body.ref === "main" && !disp.body.inputs, JSON.stringify({ d, disp }));
}
{
  llamadas = []; corridas = [];
  const r = await pedir("/api/scrape", { exp: "ID-8f0c2a4e-1111-4b7a-9c1d-000000000001" }); const d = await r.json();
  const disp = llamadas.find((c) => /dispatches$/.test(c.u));
  check("/api/scrape sigue disparando winlab-scraper.yml y pasa el «ID-<uuid>» de la app como objetivo", d.dispatched && /winlab-scraper\.yml\/dispatches$/.test(disp.u) && disp.body.inputs.exp === "ID-8f0c2a4e-1111-4b7a-9c1d-000000000001", JSON.stringify(disp));
}
{
  llamadas = []; corridas = [{ id: 7, status: "queued", created_at: new Date(Date.now() - 5 * 60000).toISOString() }];
  const r = await pedir("/api/scrape-ris"); const d = await r.json();
  check("con una corrida del RIS en cola no dispara otra (already_pending) y mira la cola del RIS, no la de WinLab", d.dispatched === false && d.reason === "already_pending" && llamadas.some((c) => /workflows\/ris-scraper\.yml\/runs\?/.test(c.u)) && !llamadas.some((c) => /dispatches$/.test(c.u)), JSON.stringify({ d, llamadas }));
}
{
  llamadas = []; corridas = [{ id: 9, status: "queued", created_at: new Date(Date.now() - 90 * 60000).toISOString() }];
  const r = await pedir("/api/scrape-ris"); const d = await r.json();
  check("una corrida «zombi» (en cola hace más de 45 min) no bloquea: se cancela y se dispara", d.dispatched === true && llamadas.some((c) => /runs\/9\/cancel$/.test(c.u)), JSON.stringify(d));
}
{
  const r = await pedir("/api/scrape-ris", {}, "otro");
  check("sin el token correcto: 401 y no se llama a GitHub", r.status === 401);
  const r2 = await worker.fetch(new Request("https://w.ejemplo/api/scrape-ris", { method: "GET", headers: { "x-piso-token": "tok" } }), ENV);
  check("GET a /api/scrape-ris: 405", r2.status === 405);
}

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
