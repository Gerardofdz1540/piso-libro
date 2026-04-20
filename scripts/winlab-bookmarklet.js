/* ═══════════════════════════════════════════════════════════════════════
   Piso Libro — Bookmarklet WinLab (v7 — filtrado estricto Cirugía General)
   ═══════════════════════════════════════════════════════════════════════
   SOLO marca reportes de pacientes de Cirugía General y subespecialidades:
     CG, CCR (coloproctología), CV (vascular), CPR (plástica),
     CT (tórax), CTV (toracovascular), CMF (maxilofacial), URO (urología),
     CG/GYO, CG/CV (mixtas con CG)
   Excluye: NCX (neurocx), TYO (trauma/orto), GYO (gineco),
     ONCOCIRUGÍA, ENDOS (endoscopía), COLUMNA, Pediatría, Med Interna, etc.

   Para instalar:
   1. Copia TODO el código desde "javascript:" hasta la última ");".
   2. Crea un favorito nuevo en Firefox/Chrome.
   3. Ponle nombre: "📋 Sync censo WinLab (CG)".
   4. Pega el código en el campo URL.
   5. Guarda.

   Cómo usarlo:
   1. Abre WinLab → Reportes → Lista.
   2. Espera que carguen los resultados.
   3. Clic al bookmark.
   4. Toast mostrará algo tipo:
      "✅ 18 de 22 pacientes CG encontrados · 🚫 24 no-CG ignorados"
   5. Clic en "Imprime Reportes" → descarga PDF.
   6. Arrastra el PDF a piso-libro → Carga Masiva de Labs.
   ═══════════════════════════════════════════════════════════════════════ */

javascript:(async()=>{
  const SUPA_URL="https://vkxplmrzyqlamxpbtmes.supabase.co";
  const SUPA_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZreHBsbXJ6eXFsYW14cGJ0bWVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NTg1MjcsImV4cCI6MjA4NzUzNDUyN30.zChMOiKnxNv3pLyt2Fqi7zUh0ET5rn1a5L6S3RV1Q98";

  // Whitelist de especialidades de Cirugía General y subespecialidades
  const CG_ESPS = new Set([
    "CG", "CCR", "CV", "CPR", "CT", "CTV", "CMF", "URO",
    "CG/GYO", "CG/CV", "GYO/CG", "CV/CG"
  ]);
  const isCG = esp => {
    const e = String(esp || "").toUpperCase().trim();
    if (!e) return false;
    if (CG_ESPS.has(e)) return true;
    // Acepta cualquier combinación que incluya CG
    if (/(^|[\/\s])CG([\/\s]|$)/.test(e)) return true;
    return false;
  };

  // ── Toast helper ─────────────────────────────────────────────────────
  const toast=(msg,color)=>{
    let t=document.getElementById("__pl_toast__");
    if(!t){t=document.createElement("div");t.id="__pl_toast__";
      t.style.cssText="position:fixed;top:20px;right:20px;z-index:99999;padding:14px 20px;border-radius:10px;font-family:-apple-system,sans-serif;font-size:14px;font-weight:600;color:#fff;box-shadow:0 8px 32px rgba(0,0,0,.25);max-width:440px;line-height:1.4;white-space:pre-line";
      document.body.appendChild(t);}
    t.style.background=color||"#0369a1";t.textContent=msg;t.style.display="block";
    clearTimeout(t._to);t._to=setTimeout(()=>t.style.display="none",10000);
  };

  toast("⏳ Leyendo censo de piso-libro…","#0369a1");

  // ── 1. Fetch active census from Supabase ────────────────────────────
  let pts;
  try{
    const r=await fetch(SUPA_URL+"/rest/v1/patients?select=cama,exp,nombre,esp",{headers:{apikey:SUPA_KEY,Authorization:"Bearer "+SUPA_KEY}});
    if(!r.ok)throw new Error("HTTP "+r.status);
    pts=await r.json();
  }catch(e){toast("❌ No pude leer el censo de Supabase: "+e.message,"#dc2626");return;}
  if(!pts||!pts.length){toast("⚠️ El censo de piso-libro está vacío. Importa primero el Excel.","#d97706");return;}

  // ── 1.5 FILTRO CRÍTICO: solo Cirugía General y subespecialidades ────
  const ptsAll = pts;
  pts = pts.filter(p => isCG(p.esp));
  const nonCGCount = ptsAll.length - pts.length;
  if (!pts.length) {
    toast("⚠️ No hay pacientes de Cirugía General en el censo.\n\nTodos son de otras especialidades (" + ptsAll.length + " pacientes). Revisa la columna ESP del censo.", "#d97706");
    return;
  }
  toast("🔍 " + pts.length + " pacientes CG · 🚫 " + nonCGCount + " no-CG ignorados\nBuscando en WinLab…", "#0369a1");

  // ── 2. Build fast lookup: lastnames → patient ───────────────────────
  const normalize=s=>String(s||"").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ").trim();
  const byKey=new Map();
  pts.forEach(p=>{
    const parts=normalize(p.nombre).split(" ").filter(Boolean);
    if(parts.length<2)return;
    const key=parts[0]+" "+parts[1];
    byKey.set(key,p);
    if(!byKey.has(parts[0]))byKey.set(parts[0],p);
  });

  // ── 3. Find patient rows in WinLab list ─────────────────────────────
  const allRows=Array.from(document.querySelectorAll("table tr"));
  let matched=0,missed=[],checkedBoxes=0,nonCGSkipped=0;
  const seenPts=new Set();

  // Set de nombres normalizados NO-CG para evitar marcar sus checkboxes
  const nonCGKeys = new Set();
  ptsAll.filter(p => !isCG(p.esp)).forEach(p => {
    const parts = normalize(p.nombre).split(" ").filter(Boolean);
    if (parts.length >= 2) nonCGKeys.add(parts[0] + " " + parts[1]);
    if (parts.length >= 1) nonCGKeys.add(parts[0]);
  });

  for(let i=0;i<allRows.length;i++){
    const row=allRows[i];
    const cells=Array.from(row.cells||[]).map(c=>normalize(c.innerText));
    if(cells.length<2)continue;
    const isHeader=cells.some(c=>c==="FEMENINO"||c==="MASCULINO");
    if(!isHeader)continue;

    let apellidos="",nombres="";
    for(let c=0;c<cells.length;c++){
      if(cells[c]==="FEMENINO"||cells[c]==="MASCULINO"){
        apellidos=cells[c-2]||"";
        nombres=cells[c-1]||"";
        break;
      }
    }
    if(!apellidos)continue;

    const apParts=apellidos.split(" ").filter(Boolean);
    const noParts=nombres.split(" ").filter(Boolean);

    // ── Check si es un paciente NO-CG: SKIP explícito ─────────────────
    const fullKey = apParts[0] + " " + (apParts[1] || "");
    const firstKey = apParts[0] || "";
    if (nonCGKeys.has(fullKey) || (nonCGKeys.has(firstKey) && !byKey.has(fullKey))) {
      nonCGSkipped++;
      continue;
    }

    // ── Match con CG ──────────────────────────────────────────────────
    let matchedPt=null;
    if(apParts.length>=2){
      matchedPt=byKey.get(apParts[0]+" "+apParts[1]);
    }
    if(!matchedPt&&apParts.length>=1){
      matchedPt=byKey.get(apParts[0]+" "+(noParts[0]||""))||byKey.get(apParts[0]);
    }
    if(!matchedPt){missed.push(apellidos+" "+nombres);continue;}
    matched++;
    seenPts.add(matchedPt.exp||matchedPt.nombre);

    // Marcar checkboxes de los reportes
    for(let j=i+1;j<allRows.length;j++){
      const nxt=allRows[j];
      const nxtCells=Array.from(nxt.cells||[]).map(c=>normalize(c.innerText));
      if(nxtCells.some(c=>c==="FEMENINO"||c==="MASCULINO"))break;
      const cb=nxt.querySelector('input[type="checkbox"]');
      if(cb&&!cb.checked){cb.click();checkedBoxes++;}
    }
  }

  // ── 4. Report ───────────────────────────────────────────────────────
  const missingFromWinlab=pts.filter(p=>!seenPts.has(p.exp||p.nombre)).map(p=>p.nombre).slice(0,6);
  let msg=`✅ ${matched} pacientes CG encontrados\n📋 ${checkedBoxes} reportes marcados\n🚫 ${nonCGSkipped} pacientes no-CG ignorados en WinLab\n`;
  if(nonCGCount>0)msg+=`🚫 ${nonCGCount} pacientes no-CG ignorados del censo\n`;
  if(missingFromWinlab.length){
    msg+=`\n⚠️ CG sin labs hoy (${pts.length-matched}/${pts.length}):\n`+missingFromWinlab.map(n=>"  • "+n.split(" ").slice(0,3).join(" ")).join("\n");
    if(pts.length-matched>missingFromWinlab.length)msg+=`\n  … y ${pts.length-matched-missingFromWinlab.length} más`;
  }
  msg+=`\n\n👉 Ahora "Imprime Reportes"`;
  toast(msg,matched?"#15803d":"#d97706");
})();
