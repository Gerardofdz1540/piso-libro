#!/usr/bin/env node
/*
 * lint-index.js — revisor de los <script> inline de index.html, sin dependencias.
 *
 *   node tools/lint-index.js [index.html]      (npm run lint)
 *
 * 1) Extrae cada <script> sin src (igual que tests/headless/syncheck.js) y comprueba la sintaxis con
 *    vm.Script. Un error de sintaxis se reporta con la línea exacta del archivo (V8 pone la línea
 *    relativa al bloque al inicio de e.stack, `inline<N>.js:<línea>`), no con la del inicio del bloque.
 * 2) En cada bloque busca declaraciones repetidas en el MISMO ámbito: `function NOMBRE` (también
 *    async / generadora), `const NOMBRE`, `let NOMBRE` y `class NOMBRE`, al nivel del bloque o dentro
 *    de cualquier `{ … }` (por ejemplo el cuerpo de una IIFE). Dos `function` con el mismo nombre en
 *    el mismo ámbito no dan error en el navegador: gana la última y la primera queda muerta aunque
 *    parezca viva (así pasó con printPrePostQx). `const`/`let`/`class` repetidas sí son SyntaxError;
 *    el bloque se escanea de todos modos (aunque vm.Script haya fallado) para listar las dos líneas
 *    exactas de la DUPLICADA. `var` no se revisa: repetirla es legal y común.
 *
 * Escáner propio (sin parser): recorre el texto saltando comentarios, cadenas, plantillas con
 * `${…}` anidado y literales de expresión regular, y lleva una pila de ámbitos por llave.
 * Sale con código 1 si hay errores de sintaxis o duplicados.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = process.argv[2] || path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(file, "utf8");
const rel = path.relative(process.cwd(), file) || file;

// ── Extracción de bloques <script> inline ──────────────────────────────────
const SCRIPT_RE = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const blocks = [];
let m;
while ((m = SCRIPT_RE.exec(html))) {
  const codeStart = m.index + m[0].indexOf(m[1]);
  const line = html.slice(0, codeStart).split("\n").length; // línea del primer carácter del código
  blocks.push({ n: blocks.length + 1, code: m[1], line });
}

// ── Escáner léxico mínimo ──────────────────────────────────────────────────
const ID_START = /[A-Za-z_$\u00C0-\uFFFF]/;
const ID_PART = /[A-Za-z0-9_$\u00C0-\uFFFF]/;
// Tras estas palabras clave un `/` abre una expresión regular, no una división.
const KW_BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
// Tras estos signos un `/` también es regex.
const PUNCT_BEFORE_REGEX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "=>"]);
// Un `function`/`const`/… es declaración si el token previo cierra una sentencia.
const STMT_END = new Set(["", ";", "{", "}"]);

function isIdent(s) { return !!s && ID_START.test(s[0]) && /^[A-Za-z0-9_$\u00C0-\uFFFF]+$/.test(s); }

// Nombres que declara un patrón de desestructuración sencillo: `{ a, b: c, d = 1, ...e }` / `[a, , b]`.
function patternNames(src) {
  const out = [];
  let depth = 0, cur = "";
  const flush = () => {
    let s = cur.trim();
    cur = "";
    if (!s) return;
    if (s.includes(":")) s = s.slice(s.lastIndexOf(":") + 1);
    if (s.includes("=")) s = s.slice(0, s.indexOf("="));
    s = s.replace(/^\.\.\./, "").trim();
    if (isIdent(s)) out.push(s);
  };
  for (const ch of src) {
    if (ch === "{" || ch === "[") { depth++; if (depth === 1) continue; }
    if (ch === "}" || ch === "]") { depth--; if (depth === 0) { flush(); continue; } }
    if (ch === "," && depth === 1) { flush(); continue; }
    if (depth >= 1) cur += ch;
  }
  flush();
  return out;
}

function scanBlock(block) {
  const src = block.code;
  const found = []; // { kind, name, line, scope }
  const scopes = [new Map()]; // pila de ámbitos: nombre → { kind, line }
  let i = 0, line = 1;
  let prevTok = "";        // último token significativo (texto)
  let prevTokIsWord = false;
  let prevTokIsAsync = false;
  let newlineSincePrev = false;
  const tmpl = [];         // pila de plantillas: profundidad de llaves al abrir cada `${`
  let braceDepth = 0;
  let pendingDecl = null;  // { kind, line } tras ver function/const/let/class

  const setPrev = (tok, isWord) => {
    prevTokIsAsync = isWord && tok === "async";
    prevTok = tok; prevTokIsWord = isWord; newlineSincePrev = false;
  };
  const stmtStart = () => {
    if (STMT_END.has(prevTok)) return true;
    if (!newlineSincePrev) return false;
    // Nueva línea: ASI salvo que el token previo sea un operador que continúe la expresión.
    return prevTok === ")" || prevTok === "]" || prevTokIsWord;
  };
  const declare = (kind, name, declLine) => {
    const scope = scopes[scopes.length - 1];
    const prev = scope.get(name);
    if (prev) found.push({ kind, name, line: declLine, first: prev.line, firstKind: prev.kind });
    else scope.set(name, { kind, line: declLine });
  };

  while (i < src.length) {
    const ch = src[i], nx = src[i + 1];
    if (ch === "\n") { line++; newlineSincePrev = true; i++; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
    // comentarios
    if (ch === "/" && nx === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "/" && nx === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === "\n") line++;
      i = stop; newlineSincePrev = true; continue;
    }
    // cadenas
    if (ch === "'" || ch === '"') {
      let k = i + 1;
      while (k < src.length && src[k] !== ch) { if (src[k] === "\\") k++; else if (src[k] === "\n") line++; k++; }
      i = k + 1; setPrev("str", true); pendingDecl = null; continue;
    }
    // plantillas: al cerrar la llave de un `${…}` se vuelve a leer texto de plantilla
    if (ch === "`" || (ch === "}" && tmpl.length && tmpl[tmpl.length - 1] === braceDepth - 1)) {
      if (ch === "}") { tmpl.pop(); braceDepth--; if (scopes.length > 1) scopes.pop(); }
      let k = i + 1, closed = false;
      while (k < src.length) {
        const c = src[k];
        if (c === "\\") { k += 2; continue; }
        if (c === "\n") { line++; k++; continue; }
        if (c === "`") { closed = true; k++; break; }
        if (c === "$" && src[k + 1] === "{") { tmpl.push(braceDepth); braceDepth++; scopes.push(new Map()); k += 2; break; }
        k++;
      }
      i = k;
      if (closed) { setPrev("str", true); pendingDecl = null; }
      continue;
    }
    // regex
    if (ch === "/" && (prevTok === "" || PUNCT_BEFORE_REGEX.has(prevTok) || (prevTokIsWord && KW_BEFORE_REGEX.has(prevTok)))) {
      let k = i + 1, inClass = false;
      while (k < src.length) {
        const c = src[k];
        if (c === "\\") { k += 2; continue; }
        if (c === "\n") break; // regex mal cerrada: no romper el escáner
        if (inClass) { if (c === "]") inClass = false; }
        else if (c === "[") inClass = true;
        else if (c === "/") { k++; break; }
        k++;
      }
      while (k < src.length && ID_PART.test(src[k])) k++; // banderas
      i = k; setPrev("regex", true); pendingDecl = null; continue;
    }
    // identificadores / palabras clave
    if (ID_START.test(ch)) {
      let k = i + 1;
      while (k < src.length && ID_PART.test(src[k])) k++;
      const word = src.slice(i, k);
      if (pendingDecl) {
        declare(pendingDecl.kind, word, pendingDecl.line); pendingDecl = null;
      } else if (word === "function" && (stmtStart() || (prevTokIsAsync && newlineSincePrev === false))) {
        // `async function f` cuenta si el `async` estaba al inicio de sentencia; lo aceptamos sin más.
        pendingDecl = { kind: "function", line };
      } else if ((word === "const" || word === "let" || word === "class") && stmtStart()) {
        // desestructuración: `const { a, b } = …` / `const [x] = …`
        let j = k; while (j < src.length && /\s/.test(src[j])) j++;
        if (word !== "class" && (src[j] === "{" || src[j] === "[")) {
          const open = src[j], close = open === "{" ? "}" : "]";
          let depth = 0, e = j;
          for (; e < src.length; e++) { if (src[e] === open) depth++; else if (src[e] === close) { depth--; if (!depth) { e++; break; } } }
          for (const nm of patternNames(src.slice(j, e))) declare(word, nm, line);
          for (let q = i; q < e; q++) if (src[q] === "\n") line++;
          i = e; setPrev("pattern", true); continue;
        }
        pendingDecl = { kind: word, line };
      }
      i = k; setPrev(word, true); continue;
    }
    // números
    if (/[0-9]/.test(ch)) {
      let k = i + 1; while (k < src.length && /[0-9A-Za-z_.]/.test(src[k])) k++;
      i = k; setPrev("num", true); pendingDecl = null; continue;
    }
    // `function* gen` — el asterisco no cancela la declaración pendiente
    if (ch === "*" && pendingDecl && pendingDecl.kind === "function") { i++; continue; }
    // llaves: ámbitos
    if (ch === "{") { braceDepth++; scopes.push(new Map()); i++; setPrev("{", false); pendingDecl = null; continue; }
    if (ch === "}") { braceDepth--; if (scopes.length > 1) scopes.pop(); i++; setPrev("}", false); pendingDecl = null; continue; }
    // `=>` como token propio (antes de un `/` abre regex)
    if (ch === "=" && nx === ">") { i += 2; setPrev("=>", false); pendingDecl = null; continue; }
    i++; setPrev(ch, false); pendingDecl = null;
  }
  // Si las llaves no cuadran, el escáner se perdió (regex o plantilla mal leída) y pudo saltarse ámbitos.
  if (braceDepth !== 0 || scopes.length !== 1) console.log("AVISO: llaves desbalanceadas en <script> #" + block.n + " (profundidad final " + braceDepth + "); revisar el escáner");
  return found;
}

// ── Ejecución ──────────────────────────────────────────────────────────────
let syntaxErrors = 0, dups = 0;
for (const b of blocks) {
  try { new vm.Script(b.code, { filename: "inline" + b.n + ".js" }); }
  catch (e) {
    syntaxErrors++;
    // e.stack empieza con `inline<N>.js:<línea relativa al bloque>`; la pasamos a línea del archivo.
    const at = /^inline\d+\.js:(\d+)/.exec(String(e.stack || ""));
    const where = at ? rel + ":" + (b.line + Number(at[1]) - 1) : "línea " + b.line + " en adelante";
    console.log("ERROR DE SINTAXIS en <script> #" + b.n + " (" + where + "): " + e.message);
    // Sin `continue`: si el error es una const/let/class repetida, scanBlock da las dos líneas exactas.
  }
  for (const d of scanBlock(b)) {
    dups++;
    const kind = d.kind === d.firstKind ? d.kind : d.firstKind + "/" + d.kind;
    console.log("DUPLICADA " + kind + " " + d.name + ": " + rel + ":" + (b.line + d.first - 1) + " y " + rel + ":" + (b.line + d.line - 1) + " (<script> #" + b.n + ", mismo ámbito)");
  }
}
console.log("inline scripts: " + blocks.length + ", errores de sintaxis: " + syntaxErrors + ", declaraciones duplicadas: " + dups);
process.exit(syntaxErrors || dups ? 1 : 0);
