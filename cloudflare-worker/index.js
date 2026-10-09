// piso-libro-ai Worker — v4 (jun 2026)
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
//
// Variables de entorno requeridas (Cloudflare Workers → Settings → Variables):
//   ACCESS_TOKEN     (encrypted) — token compartido con el frontend
//   GEMINI_API_KEY   (encrypted) — API key de Google AI Studio

const GEMINI_MODEL = "gemini-2.5-pro";

// Orígenes permitidos para CORS. Agrega aquí cualquier URL adicional desde donde
// llames al Worker (localhost para dev, Cloudflare Pages para prod, etc.)
const ALLOWED_ORIGINS = new Set([
  "http://localhost:8000",
  "http://localhost:3000",
  "http://127.0.0.1:8000",
  "https://pisolibro.pages.dev",       // prod actual (Cloudflare Pages, proyecto pisolibro)
  "https://piso-libro.pages.dev",      // URL vieja (transición)
  "https://gerardofdz1540.github.io",  // si usas GitHub Pages
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
      return handleScrapeRoute(request, env, cors);
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
async function handleScrapeRoute(request, env, cors) {
  if (!env.GITHUB_TOKEN) {
    return json({ dispatched: false, error: "GITHUB_TOKEN no configurado en el worker" }, 503, cors);
  }
  const OWNER = "Gerardofdz1540", REPO = "piso-libro", WF = "winlab-scraper.yml", REF = "main";
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
    const PENDING = ["queued", "pending", "waiting", "requested"];
    const runsResp = await gh("/actions/workflows/" + WF + "/runs?per_page=8");
    if (runsResp.ok) {
      const data = await runsResp.json();
      const pending = (data.workflow_runs || []).filter((r) => PENDING.includes(r.status));
      if (pending.length > 0) {
        return json({ dispatched: false, reason: "already_pending",
          message: "Ya hay una corrida en cola; tomará el censo más reciente." }, 200, cors);
      }
    }
    // Disparar (204 = OK). Una corrida en progreso NO bloquea: la nueva se encola.
    const dResp = await gh("/actions/workflows/" + WF + "/dispatches", {
      method: "POST", body: JSON.stringify({ ref: REF })
    });
    if (dResp.status === 204) {
      return json({ dispatched: true, message: "Scraper disparado." }, 200, cors);
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

  const geminiBody = {
    contents: geminiContents,
    safetySettings,
    // FIX (jun 2026): gemini-2.5-pro es un modelo de RAZONAMIENTO; sus "thinking tokens"
    // cuentan contra maxOutputTokens. Con 8192 y un documento, el thinking consumía TODO
    // el presupuesto → salida VACÍA, finishReason=MAX_TOKENS → "La IA no devolvió JSON"
    // (Leer Doc / lectura inteligente). Solución: subir maxOutputTokens y ACOTAR el
    // thinking para que SIEMPRE quede espacio de salida.
    generationConfig: {
      maxOutputTokens: 65536,
      temperature: 0.1,
      thinkingConfig: { thinkingBudget: 8192 }
    }
  };

  let upstream;
  try {
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geminiBody) }
    );
  } catch (e) {
    console.error("[GEMINI] Upstream fetch failed:", e.message);
    return json({ error: "Upstream fetch failed" }, 502, cors);
  }

  const upstreamData = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    // 🔒 FIX MEDIO: NO devolver upstream data al cliente (puede tener info sensible)
    console.error("[GEMINI] API error:", JSON.stringify(upstreamData).slice(0, 500));
    return json({ error: "Gemini API error" }, upstream.status, cors);
  }

  const cand = upstreamData.candidates?.[0];
  const outText = (cand?.content?.parts || []).map(p => p.text || "").join("");

  // 🔒 FIX MEDIO: si la respuesta está vacía, log server-side, NO al cliente
  if (!outText) {
    console.warn(`[GEMINI] Empty response. finishReason=${cand?.finishReason} safetyRatings=${JSON.stringify(cand?.safetyRatings)}`);
    return json({
      id: "gemini-" + Date.now(),
      type: "message",
      role: "assistant",
      model: GEMINI_MODEL,
      content: [{ type: "text", text: "[Respuesta vacía del modelo. Revisa los logs del Worker para más detalle.]" }],
      stop_reason: cand?.finishReason || "stop"
    }, 200, cors);
  }

  return json({
    id: "gemini-" + Date.now(),
    type: "message",
    role: "assistant",
    model: GEMINI_MODEL,
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

  const geminiBody = {
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
    generationConfig: {
      // FIX (jun 2026): mismo problema de thinking-tokens que /api/ai. Subir el techo y
      // acotar el thinking para que la extracción de labs no quede vacía/truncada.
      maxOutputTokens: 65536,
      temperature: 0.0,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 8192 }
    }
  };

  let upstream;
  try {
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geminiBody) }
    );
  } catch (e) {
    console.error("[GEMINI/extract] Upstream fetch failed:", e.message);
    return json({ error: "Upstream fetch failed" }, 502, cors);
  }

  const upstreamData = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    // 🔒 FIX MEDIO: log server-side, no exponer upstream al cliente
    console.error("[GEMINI/extract] API error:", JSON.stringify(upstreamData).slice(0, 500));
    return json({
      error: "Gemini API error",
      patients: [],
      warnings: ["Error del proveedor IA. Revisa logs del Worker."]
    }, upstream.status, cors);
  }

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
