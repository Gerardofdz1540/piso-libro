// piso-libro-ai Worker — v6 (27 oct 2026)
// Cambios v6:
//   ⚡ Modelo de IA por tarea: la app marca {tarea:"transcribir"} al leer lo escrito con el lápiz (una palabra o un
//      número) y eso va a un modelo rápido sin razonamiento; notas, documentos y labs siguen en el modelo grande.
//   🛟 Modelo de respaldo: si el modelo responde 404 (retirado), 429 (cuota), 5xx (saturado) o 400 (no admite la
//      configuración), se reintenta una vez con el otro. Los modelos se cambian sin tocar el código con las variables
//      GEMINI_MODEL, GEMINI_MODEL_RAPIDO y GEMINI_MODEL_RESPALDO (Settings → Variables).
//   ➕ CORS: https://pisocirugiahgl.netlify.app (el espejo de Netlify ya no queda sin IA).
// Cambios v5:
//   ➕ /api/scrape-ris: Supabase dispara el robot del RIS cada 2 h (antes solo el cron de GitHub, cada 4-6 h)
// Cambios v4:
//   ➕ CORS: agregado https://pisolibro.pages.dev (URL nueva de Cloudflare Pages)
// Cambios v3 (mayo 2026):
//   🔒 FIX CRÍTICO: fail-closed si ACCESS_TOKEN no está configurado
//   🔒 FIX MEDIO: CORS restringido a orígenes conocidos
//   🔒 FIX MEDIO: debug info NUNCA expuesta al cliente (solo console.log)
//
// IMPORTANTE: este archivo ES la fuente de verdad del worker DESPLEGADO
// `piso-libro-ai` (no `piso-libro-labs-worker`). Usa Gemini, no Anthropic.
//
// Rutas:
//   POST /api/ai            → endpoint existente (formato Anthropic Messages)
//   POST /api/labs/extract  → para Labs Masivo (extrae pacientes+labs de PDF)
//   POST /api/scrape        → dispara el robot WinLab; con cuerpo {"exp":"ID-<uuid>"} (o un expediente) busca
//                             solo a ese paciente (oct 2026, botón «🔎 Buscar ahora» de la tarjeta)
//   POST /api/scrape-ris    → dispara el robot del RIS (imagen). Lo llama Supabase cada 2 h (pg_cron, 27 oct 2026):
//                             el cron de GitHub lo lanzaba cada 4-6 h y los estudios llegaban tarde.
//
// Variables de entorno requeridas (Cloudflare Workers → Settings → Variables):
//   ACCESS_TOKEN     (encrypted) — token compartido con el frontend
//   GEMINI_API_KEY   (encrypted) — API key de Google AI Studio
//   GITHUB_TOKEN     (encrypted) — token de GitHub con permiso "actions: write" en el repo
//                    piso-libro; lo usa /api/scrape para disparar el robot WinLab (sin él,
//                    el botón de la app y el cron de Supabase responden 503 "no configurado")
// Opcionales (texto, v6): GEMINI_MODEL (principal), GEMINI_MODEL_RAPIDO (lápiz), GEMINI_MODEL_RESPALDO.

const GEMINI_MODEL = "gemini-2.5-pro";          // principal: notas, documentos, fotos de notas, labs
const GEMINI_MODEL_RAPIDO = "gemini-2.5-flash"; // tarea "transcribir": lo escrito con el lápiz
const GEMINI_REINTENTA = new Set([400, 404, 408, 429, 500, 502, 503, 504]);   // 401/403 = llave: el respaldo no ayuda

// Orden de modelos para una tarea: el que toca y, si es distinto, el de respaldo.
function modelosPara(env, tarea) {
  const principal = (env && env.GEMINI_MODEL) || GEMINI_MODEL;
  const rapido = (env && env.GEMINI_MODEL_RAPIDO) || GEMINI_MODEL_RAPIDO;
  const primero = tarea === "transcribir" ? rapido : principal;
  const respaldo = (env && env.GEMINI_MODEL_RESPALDO) || (primero === principal ? rapido : principal);
  return primero === respaldo ? [primero] : [primero, respaldo];
}
// Los modelos "flash" permiten apagar el razonamiento (thinkingBudget 0) y bastan unos pocos tokens; los "pro" no lo
// permiten: sus tokens de razonamiento cuentan contra maxOutputTokens, así que se acota el razonamiento y se deja techo.
function generacionPara(modelo, maxTokens) {
  if (/flash/i.test(modelo)) return { maxOutputTokens: Math.min(16384, Math.max(1024, 2 * (Number(maxTokens) || 2048))), thinkingConfig: { thinkingBudget: 0 } };
  return { maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 8192 } };
}
// Llama a Gemini con el primer modelo y, si falla de una forma que el otro puede resolver, con el de respaldo.
async function geminiConRespaldo(env, modelos, armarCuerpo, etiqueta) {
  let ultimo = { ok: false, status: 502, data: {}, model: modelos[0] };
  for (const modelo of modelos) {
    let resp;
    try {
      resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${env.GEMINI_API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(armarCuerpo(modelo)) });
    } catch (e) {
      console.error(`[${etiqueta}] ${modelo}: fetch falló:`, e && e.message);
      ultimo = { ok: false, status: 502, data: {}, model: modelo };
      continue;
    }
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return { ok: true, status: 200, data, model: modelo };
    console.error(`[${etiqueta}] ${modelo}: HTTP ${resp.status}`, JSON.stringify(data).slice(0, 500));
    ultimo = { ok: false, status: resp.status, data, model: modelo };
    if (!GEMINI_REINTENTA.has(resp.status)) break;
  }
  return ultimo;
}

// Orígenes permitidos para CORS. Agrega aquí cualquier URL adicional desde donde
// llames al Worker (localhost para dev, Cloudflare Pages para prod, etc.)
const ALLOWED_ORIGINS = new Set([
  "http://localhost:8000",
  "http://localhost:3000",
  "http://127.0.0.1:8000",
  "https://pisolibro.pages.dev",       // prod actual (Cloudflare Pages, proyecto pisolibro)
  "https://piso-libro.pages.dev",      // URL vieja (transición)
  "https://gerardofdz1540.github.io",  // si usas GitHub Pages
  "https://pisocirugiahgl.netlify.app", // espejo de Netlify (v6)
]);

function buildCorsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  // Si el origen está en la whitelist, permitirlo. Si no, no devolver CORS
  // (esto bloquea cross-origin requests del browser, no del backend).
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-piso-token, anthropic-version",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request, env) {
    const cors = buildCorsHeaders(request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // ─── FIX CRÍTICO: fail-closed si ACCESS_TOKEN no está configurado ──────
    if (!env.ACCESS_TOKEN) {
      console.error("[SECURITY] ACCESS_TOKEN no está configurado en Variables");
      return json({ error: "Server misconfigured" }, 500, cors);
    }
    if (!env.GEMINI_API_KEY) {
      console.error("[SECURITY] GEMINI_API_KEY no está configurado en Variables");
      return json({ error: "Server misconfigured" }, 500, cors);
    }

    // Auth (token via Bearer o x-piso-token)
    const auth = request.headers.get("authorization") || "";
    const pisoToken = request.headers.get("x-piso-token") || "";
    const bearerOK = auth === `Bearer ${env.ACCESS_TOKEN}`;
    const pisoOK = pisoToken === env.ACCESS_TOKEN;
    if (!bearerOK && !pisoOK) {
      console.warn(`[AUTH] Unauthorized request from ${request.headers.get("cf-connecting-ip") || "unknown"}`);
      return json({ error: "Unauthorized" }, 401, cors);
    }

    const url = new URL(request.url);

    // ─── RUTA 1: /api/ai ─────────────────────────────────────────────────
    if (url.pathname === "/api/ai") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors });
      return handleAiRoute(request, env, cors);
    }

    // ─── RUTA 2: /api/labs/extract ───────────────────────────────────────
    if (url.pathname === "/api/labs/extract") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors });
      return handleLabsExtractRoute(request, env, cors);
    }

    // ─── RUTA 3: /api/scrape — dispara el scraper WinLab (con dedup anti-cruce) ──
    if (url.pathname === "/api/scrape") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors });
      return handleScrapeRoute(request, env, cors, "winlab-scraper.yml");
    }

    // ─── RUTA 4: /api/scrape-ris — dispara el robot del RIS (mismo control de cola, sin corrida dirigida) ──
    if (url.pathname === "/api/scrape-ris") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors });
      return handleScrapeRoute(request, env, cors, "ris-scraper.yml");
    }

    return json({ error: "Not Found" }, 404, cors);
  }
};

// ─── HANDLER: /api/scrape — dispara el workflow del scraper WinLab ─────────────
// DEDUP anti-cruce: si ya hay una corrida pendiente (en cola), NO dispara otra —
// esa corrida leerá el censo MÁS RECIENTE de Supabase al arrancar. Así, aunque
// importes varios censos seguidos, nunca hay más de 1 corriendo + 1 en cola, y la
// última siempre toma tu censo final. El workflow ya tiene cancel-in-progress:false,
// así que una corrida nueva se ENCOLA (no reinicia ni cancela la que ya corre).
async function handleScrapeRoute(request, env, cors, wf) {
  if (!env.GITHUB_TOKEN) {
    return json({ dispatched: false, error: "GITHUB_TOKEN no configurado en el worker" }, 503, cors);
  }
  const OWNER = "Gerardofdz1540", REPO = "piso-libro", WF = wf || "winlab-scraper.yml", REF = "main";
  const dirigible = WF === "winlab-scraper.yml";   // solo el robot de WinLab acepta una corrida dirigida (input exp)
  // Corrida dirigida (oct 2026): la app manda {exp} ("🔎 Buscar ahora" en la tarjeta) y el robot
  // busca SOLO a ese paciente (input `exp` del workflow → WL_TARGET_EXP). Sin exp: censo completo.
  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const exp = dirigible ? String((body && body.exp) || "").trim().replace(/[^\w\-.,\/ ]/g, "").slice(0, 80) : "";
  const gh = (path, init) => fetch("https://api.github.com/repos/" + OWNER + "/" + REPO + path, {
    ...(init || {}),
    headers: {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "User-Agent": "piso-libro-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...((init && init.headers) || {})
    }
  });
  try {
    // ¿Hay alguna corrida que aún NO arranca (cola/espera)? Si sí, no dispares otra.
    // ZOMBIS: GitHub a veces deja una corrida "queued" para siempre (la #385 del 9-oct-2026 pasó
    // 2 días así) y eso bloqueaba TODOS los disparos (botón de la app y cron de Supabase) con
    // "already_pending". Una corrida en cola de más de ZOMBIE_MIN minutos no cuenta como pendiente
    // y se intenta cancelar (mejor esfuerzo) para que no estorbe en la lista.
    const PENDING = ["queued", "pending", "waiting", "requested"];
    const ZOMBIE_MIN = 45;
    const runsResp = await gh("/actions/workflows/" + WF + "/runs?per_page=8");
    if (runsResp.ok) {
      const data = await runsResp.json();
      const now = Date.now();
      const ageMin = (r) => (now - Date.parse(r.created_at || r.run_started_at || 0)) / 60000;
      const queued = (data.workflow_runs || []).filter((r) => PENDING.includes(r.status));
      const zombies = queued.filter((r) => ageMin(r) > ZOMBIE_MIN);
      const pending = queued.filter((r) => ageMin(r) <= ZOMBIE_MIN);
      for (const z of zombies) {
        try { await gh("/actions/runs/" + z.id + "/cancel", { method: "POST" }); } catch (_) { /* mejor esfuerzo */ }
      }
      if (pending.length > 0) {
        return json({ dispatched: false, reason: "already_pending",
          message: "Ya hay una corrida en cola; tomará el censo más reciente." }, 200, cors);
      }
    }
    // Disparar (204 = OK). Una corrida en progreso NO bloquea: la nueva se encola.
    const dResp = await gh("/actions/workflows/" + WF + "/dispatches", {
      method: "POST", body: JSON.stringify(exp ? { ref: REF, inputs: { exp } } : { ref: REF })
    });
    if (dResp.status === 204) {
      return json({ dispatched: true, exp: exp || null, message: exp ? "Robot disparado para " + exp + "." : "Scraper disparado." }, 200, cors);
    }
    const detail = await dResp.text().catch(() => "");
    return json({ dispatched: false, reason: "dispatch_failed", status: dResp.status, detail: detail.slice(0, 240) }, 502, cors);
  } catch (e) {
    return json({ dispatched: false, reason: "exception", detail: String(e && e.message || e).slice(0, 240) }, 500, cors);
  }
}

// ─── HANDLER: /api/ai (formato Anthropic Messages) ─────────────────────────
async function handleAiRoute(request, env, cors) {
  let payload;
  try { payload = await request.json(); }
  catch (e) { return json({ error: "Invalid JSON" }, 400, cors); }

  const geminiContents = [];
  for (const msg of (payload.messages || [])) {
    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];
    const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content || "") }];
    for (const c of content) {
      if (c.type === "text") parts.push({ text: c.text || "" });
      else if (c.type === "document" && c.source?.type === "base64")
        parts.push({ inline_data: { mime_type: c.source.media_type || "application/pdf", data: c.source.data } });
      else if (c.type === "image" && c.source?.type === "base64")
        parts.push({ inline_data: { mime_type: c.source.media_type || "image/png", data: c.source.data } });
    }
    if (parts.length) geminiContents.push({ role, parts });
  }

  const safetySettings = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
  ];

  // FIX (jun 2026): gemini-2.5-pro es un modelo de RAZONAMIENTO; sus "thinking tokens" cuentan contra
  // maxOutputTokens. Con 8192 y un documento, el thinking consumía TODO el presupuesto → salida VACÍA,
  // finishReason=MAX_TOKENS → "La IA no devolvió JSON". Por eso el techo alto y el razonamiento acotado (generacionPara).
  const tarea = String((payload && payload.tarea) || "").toLowerCase();
  const r = await geminiConRespaldo(env, modelosPara(env, tarea), (modelo) => ({
    contents: geminiContents,
    safetySettings,
    generationConfig: { temperature: 0.1, ...generacionPara(modelo, payload && payload.max_tokens) }
  }), "GEMINI");
  // 🔒 FIX MEDIO: NO devolver upstream data al cliente (puede tener info sensible)
  if (!r.ok) return json({ error: "Gemini API error" }, r.status, cors);
  const upstreamData = r.data, GEMINI_USADO = r.model;

  const cand = upstreamData.candidates?.[0];
  const outText = (cand?.content?.parts || []).map(p => p.text || "").join("");

  // 🔒 FIX MEDIO: si la respuesta está vacía, log server-side, NO al cliente
  if (!outText) {
    console.warn(`[GEMINI] Empty response. finishReason=${cand?.finishReason} safetyRatings=${JSON.stringify(cand?.safetyRatings)}`);
    return json({
      id: "gemini-" + Date.now(),
      type: "message",
      role: "assistant",
      model: GEMINI_USADO,
      content: [{ type: "text", text: "[Respuesta vacía del modelo. Revisa los logs del Worker para más detalle.]" }],
      stop_reason: cand?.finishReason || "stop"
    }, 200, cors);
  }

  return json({
    id: "gemini-" + Date.now(),
    type: "message",
    role: "assistant",
    model: GEMINI_USADO,
    content: [{ type: "text", text: outText }],
    stop_reason: cand?.finishReason || "end_turn"
  }, 200, cors);
}

// ─── HANDLER: /api/labs/extract (nuevo, para Labs Masivo) ──────────────────
async function handleLabsExtractRoute(request, env, cors) {
  let payload;
  try { payload = await request.json(); }
  catch (e) { return json({ error: "Invalid JSON" }, 400, cors); }

  const { file_base64, file_name, mime_type, prompt } = payload || {};
  if (!file_base64) return json({ error: "Missing file_base64" }, 400, cors);
  if (!prompt) return json({ error: "Missing prompt" }, 400, cors);

  // Validación opcional de tamaño (base64 ~33% mayor que binario)
  // 10 MB binario ≈ 13.3 MB en base64
  const MAX_BASE64_SIZE = 14 * 1024 * 1024;
  if (file_base64.length > MAX_BASE64_SIZE) {
    return json({ error: "PDF demasiado grande (>10MB)" }, 413, cors);
  }

  // Leer labs de un PDF: siempre el modelo grande (la exactitud de los valores importa más que la velocidad); el
  // respaldo solo entra si el grande falla.
  const r = await geminiConRespaldo(env, modelosPara(env, "documento"), (modelo) => ({
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: mime_type || "application/pdf", data: file_base64 } },
        { text: prompt }
      ]
    }],
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ],
    // FIX (jun 2026): mismo problema de thinking-tokens que /api/ai (techo alto y razonamiento acotado).
    generationConfig: { temperature: 0.0, responseMimeType: "application/json", ...generacionPara(modelo, 0) }
  }), "GEMINI/extract");
  if (!r.ok) {
    // 🔒 FIX MEDIO: log server-side, no exponer upstream al cliente
    return json({
      error: "Gemini API error",
      patients: [],
      warnings: ["Error del proveedor IA. Revisa logs del Worker."]
    }, r.status, cors);
  }
  const upstreamData = r.data;

  const cand = upstreamData.candidates?.[0];
  const outText = (cand?.content?.parts || []).map(p => p.text || "").join("");

  if (!outText) {
    console.warn(`[GEMINI/extract] Empty response. finishReason=${cand?.finishReason}`);
    return json({
      patients: [],
      warnings: [`Respuesta vacía del modelo (finishReason=${cand?.finishReason || "unknown"}).`]
    }, 200, cors);
  }

  let parsed;
  try {
    const cleaned = outText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error("[GEMINI/extract] JSON parse failed:", e.message);
    return json({
      patients: [],
      warnings: ["No se pudo parsear la respuesta del modelo como JSON."]
    }, 200, cors);
  }

  return json({
    patients: Array.isArray(parsed.patients) ? parsed.patients : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    unmatched_sections: Array.isArray(parsed.unmatched_sections) ? parsed.unmatched_sections : []
  }, 200, cors);
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
}
