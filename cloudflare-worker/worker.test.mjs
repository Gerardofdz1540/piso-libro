// Pruebas sin red del worker (27 oct 2026): rutas que disparan a los robots y modelo de IA por tarea con respaldo.
// fetch de GitHub y de Gemini simulados.
//   node cloudflare-worker/worker.test.mjs
import worker from "./index.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log("✓ " + n); } else { fail++; console.log("✗ " + n + (x ? " :: " + x : "")); } };
const ENV = { ACCESS_TOKEN: "tok", GEMINI_API_KEY: "g", GITHUB_TOKEN: "gh" };
let llamadas = [], corridas = [], gemini = {};   // gemini: { "<modelo>": status } (sin entrada = 200 con texto)
globalThis.fetch = async (url, init) => {
  const u = String(url); llamadas.push({ u, m: (init && init.method) || "GET", body: init && init.body ? JSON.parse(init.body) : null });
  const mg = /models\/([^:]+):generateContent/.exec(u);
  if (mg) {
    const st = gemini[mg[1]] || 200;
    if (st !== 200) return new Response(JSON.stringify({ error: { code: st, message: "simulado" } }), { status: st });
    const cuerpo = JSON.parse(init.body);   // Labs masivo pide JSON; /api/ai, texto
    const texto = cuerpo.generationConfig.responseMimeType === "application/json" ? '{"patients":[{"nombre":"PRUEBA"}],"warnings":[]}' : "ok de " + mg[1];
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: texto }] }, finishReason: "STOP" }] }), { status: 200 });
  }
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

// ── IA (v6): modelo por tarea y respaldo ──
const aiLlamadas = () => llamadas.filter((c) => /generateContent/.test(c.u)).map((c) => ({ modelo: /models\/([^:]+):/.exec(c.u)[1], gen: c.body.generationConfig }));
const pedirAi = (body, env = ENV) => worker.fetch(new Request("https://w.ejemplo/api/ai", { method: "POST", headers: { "x-piso-token": "tok", "content-type": "application/json" }, body: JSON.stringify(body) }), env);
const msg = [{ role: "user", content: [{ type: "text", text: "hola" }] }];
{
  llamadas = []; gemini = {};
  const r = await pedirAi({ tarea: "transcribir", max_tokens: 800, messages: msg }); const d = await r.json(); const a = aiLlamadas();
  check("IA tarea «transcribir» (lápiz): modelo rápido, sin razonamiento y con tope chico (2 × max_tokens)", r.status === 200 && a.length === 1 && a[0].modelo === "gemini-2.5-flash" && a[0].gen.thinkingConfig.thinkingBudget === 0 && a[0].gen.maxOutputTokens === 1600 && d.model === "gemini-2.5-flash" && d.content[0].text === "ok de gemini-2.5-flash", JSON.stringify({ a, d }));
}
{
  llamadas = []; gemini = {};
  const r = await pedirAi({ max_tokens: 4000, messages: msg }); const d = await r.json(); const a = aiLlamadas();
  check("IA sin tarea (notas, documentos): modelo grande con razonamiento acotado y techo alto, como antes", a.length === 1 && a[0].modelo === "gemini-2.5-pro" && a[0].gen.thinkingConfig.thinkingBudget === 8192 && a[0].gen.maxOutputTokens === 65536 && d.model === "gemini-2.5-pro", JSON.stringify(a));
}
{
  llamadas = []; gemini = { "gemini-2.5-pro": 503 };
  const r = await pedirAi({ messages: msg }); const d = await r.json(); const a = aiLlamadas();
  check("IA respaldo: el grande saturado (503) → reintenta una vez con el rápido y contesta", r.status === 200 && a.map((x) => x.modelo).join(",") === "gemini-2.5-pro,gemini-2.5-flash" && d.model === "gemini-2.5-flash" && a[1].gen.thinkingConfig.thinkingBudget === 0, JSON.stringify({ a, d }));
}
{
  llamadas = []; gemini = { "gemini-2.5-flash": 404 };
  const r = await pedirAi({ tarea: "transcribir", messages: msg }); const d = await r.json();
  check("IA respaldo: el rápido retirado (404) → el lápiz sigue funcionando con el grande", r.status === 200 && d.model === "gemini-2.5-pro" && aiLlamadas().length === 2, JSON.stringify(d));
}
{
  llamadas = []; gemini = { "gemini-2.5-pro": 403 };
  const r = await pedirAi({ messages: msg }); const d = await r.json();
  check("IA llave rechazada (403): no reintenta (el respaldo usa la misma llave) y no reenvía el detalle de Google", r.status === 403 && aiLlamadas().length === 1 && d.error === "Gemini API error" && !JSON.stringify(d).includes("simulado"), JSON.stringify(d));
}
{
  llamadas = []; gemini = { "gemini-2.5-pro": 429, "gemini-2.5-flash": 429 };
  const r = await pedirAi({ messages: msg });
  check("IA sin cuota en los dos: responde el error (429) después de 2 intentos, no se queda reintentando", r.status === 429 && aiLlamadas().length === 2);
}
{
  llamadas = []; gemini = {};
  const env = { ...ENV, GEMINI_MODEL: "gemini-3-pro", GEMINI_MODEL_RAPIDO: "gemini-3-flash" };
  await pedirAi({ messages: msg }, env); await pedirAi({ tarea: "transcribir", messages: msg }, env);
  check("IA modelos configurables sin tocar el código (variables GEMINI_MODEL / GEMINI_MODEL_RAPIDO)", aiLlamadas().map((x) => x.modelo).join(",") === "gemini-3-pro,gemini-3-flash", JSON.stringify(aiLlamadas()));
}
{
  llamadas = []; gemini = { "gemini-2.5-pro": 429 };
  const r = await worker.fetch(new Request("https://w.ejemplo/api/labs/extract", { method: "POST", headers: { "x-piso-token": "tok", "content-type": "application/json" }, body: JSON.stringify({ file_base64: "JVBERi0xLjQK".repeat(20), prompt: "extrae" }) }), ENV);
  const d = await r.json(); const a = aiLlamadas();
  check("Labs masivo: siempre el modelo grande (exactitud) y, si se acaba la cuota, el respaldo; el JSON sale igual", r.status === 200 && a.map((x) => x.modelo).join(",") === "gemini-2.5-pro,gemini-2.5-flash" && a[0].gen.responseMimeType === "application/json" && Array.isArray(d.patients) && d.patients.length === 1, JSON.stringify({ a, d }));
}
{
  const r = await worker.fetch(new Request("https://w.ejemplo/api/ai", { method: "OPTIONS", headers: { origin: "https://pisocirugiahgl.netlify.app" } }), ENV);
  const r2 = await worker.fetch(new Request("https://w.ejemplo/api/ai", { method: "OPTIONS", headers: { origin: "https://otro.ejemplo" } }), ENV);
  check("CORS: el espejo de Netlify puede usar la IA; un origen desconocido no", r.headers.get("access-control-allow-origin") === "https://pisocirugiahgl.netlify.app" && r2.headers.get("access-control-allow-origin") === "null");
}

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
