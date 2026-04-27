/**
 * Cloudflare Worker: Labs extraction proxy for PisoLibro
 *
 * Required env vars/secrets:
 * - ANTHROPIC_API_KEY      (secret)
 * - WORKER_TOKEN           (secret, same value configured in PisoLibro "Config")
 * - ALLOWED_ORIGIN         (optional, e.g. https://gerardofdz1540.github.io)
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Piso-Token",
};

const DEFAULT_LABS_PROMPT = `Eres extractor clínico de laboratorios hospitalarios del HGL (Hospital General de León).
Recibirás un PDF de laboratorio con uno o varios pacientes.
Devuelve SOLO JSON válido (sin markdown ni texto extra).

Formato OBLIGATORIO:
{
  "patients": [
    {
      "paciente": "APELLIDOS NOMBRE",
      "cama": "",
      "expediente": "",
      "fecha_labs": "YYYY-MM-DD",
      "hora_labs": "HH:MM",
      "tipo": "labs|cultivo",
      "values": {
        "hb": "", "leucos": "", "plaq": "", "cr": "", "glu": "", "na": "", "k": "",
        "urea": "", "inr": "", "tp": "", "ttp": "", "fibrinogeno": "",
        "ast": "", "alt": "", "bt": "", "bd": "", "ggt": "", "fa": "",
        "mg": "", "ca": "", "p": "", "cl": "", "pcr": "", "pct": "",
        "tipo_cultivo": "", "cultivo_organismo": "", "cultivo_sensibilidades": "", "cultivo_resistencias": "",
        "micro_muestra": "", "micro_comentarios": ""
      },
      "confidence": 0.0,
      "source_excerpt": "fragmento breve literal del PDF"
    }
  ],
  "warnings": [],
  "unmatched_sections": []
}

Reglas críticas:
1) Incluye TODOS los pacientes detectables con resultados finales.
2) Si un valor no existe o está preliminar (pendiente/in corso), usa "".
3) Valores numéricos SIN unidades.
4) No inventes valores; si dudas, deja vacío y agrega warning.
5) Confidence por paciente entre 0 y 1.
6) "tipo" = "cultivo" cuando el bloque sea microbiología/cultivo.
7) Empieza con { y termina con }.`;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function cors(origin, allowedOrigin) {
  const safeOrigin = allowedOrigin || origin || "*";
  return {
    ...CORS_HEADERS,
    "Access-Control-Allow-Origin": safeOrigin,
    Vary: "Origin",
  };
}

function extractJsonObject(text) {
  const clean = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    return JSON.parse(clean.slice(first, last + 1));
  } catch (_) {
    return null;
  }
}

function normalizeOutput(parsed) {
  const out = parsed && typeof parsed === "object" ? parsed : {};
  const arr = Array.isArray(out.patients) ? out.patients : [];
  const normalizedPatients = arr.map((p) => {
    const values = p && typeof p.values === "object" ? p.values : {};
    return {
      paciente: String(p?.paciente || "").trim(),
      cama: String(p?.cama || "").trim(),
      expediente: String(p?.expediente || "").trim(),
      fecha_labs: String(p?.fecha_labs || "").trim(),
      hora_labs: String(p?.hora_labs || "").trim(),
      tipo: String(p?.tipo || "labs").trim() || "labs",
      values,
      confidence: Number.isFinite(Number(p?.confidence)) ? Number(p.confidence) : 0,
      source_excerpt: String(p?.source_excerpt || "").trim(),
    };
  }).filter((p) => p.paciente || p.cama || p.expediente);

  return {
    patients: normalizedPatients,
    warnings: Array.isArray(out.warnings) ? out.warnings.map((x) => String(x)) : [],
    unmatched_sections: Array.isArray(out.unmatched_sections) ? out.unmatched_sections.map((x) => String(x)) : [],
  };
}

async function callAnthropic({ apiKey, prompt, fileBase64, mimeType }) {
  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 8192,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: mimeType || "application/pdf",
              data: fileBase64,
            },
          },
          { type: "text", text: prompt || DEFAULT_LABS_PROMPT },
        ],
      },
    ],
  };

  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const rawText = await resp.text();
  if (!resp.ok) {
    throw new Error(`Anthropic HTTP ${resp.status}: ${rawText.slice(0, 400)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (_) {
    throw new Error("Anthropic devolvió JSON inválido.");
  }
  const llmText = parsed?.content?.[0]?.text || "";
  return { llmText, anthropicRaw: parsed };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "";
    const corsHeaders = cors(origin, allowedOrigin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/ping") {
      return json({ ok: true, service: "piso-labs-worker" }, 200, corsHeaders);
    }

    if (request.method !== "POST" || url.pathname !== "/api/labs/extract") {
      return json({ error: "Not found" }, 404, corsHeaders);
    }

    const providedToken = request.headers.get("X-Piso-Token") || "";
    if (!env.WORKER_TOKEN || providedToken !== env.WORKER_TOKEN) {
      return json({ error: "Unauthorized" }, 401, corsHeaders);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Worker misconfigured: missing ANTHROPIC_API_KEY" }, 500, corsHeaders);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (_) {
      return json({ error: "Invalid JSON payload" }, 400, corsHeaders);
    }

    const fileBase64 = String(payload?.file_base64 || "").trim();
    const fileName = String(payload?.file_name || "labs.pdf");
    const mimeType = String(payload?.mime_type || "application/pdf");
    const prompt = String(payload?.prompt || DEFAULT_LABS_PROMPT);

    if (!fileBase64 || fileBase64.length < 100) {
      return json({ error: "Missing or invalid file_base64" }, 400, corsHeaders);
    }

    try {
      const { llmText } = await callAnthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        prompt,
        fileBase64,
        mimeType,
      });

      const obj = extractJsonObject(llmText);
      if (!obj) {
        return json({
          error: "No JSON object found in Claude response",
          warnings: ["Claude response could not be parsed as JSON."],
          raw_text_preview: llmText.slice(0, 700),
        }, 422, corsHeaders);
      }

      const normalized = normalizeOutput(obj);
      if (!normalized.patients.length) {
        normalized.warnings.push(`No patient labs extracted from ${fileName}.`);
      }
      return json(normalized, 200, corsHeaders);
    } catch (err) {
      const msg = String(err?.message || err);
      const status = msg.includes("Anthropic HTTP 5") ? 502 : 500;
      return json({
        error: "Extraction failed",
        detail: msg.slice(0, 900),
      }, status, corsHeaders);
    }
  },
};
