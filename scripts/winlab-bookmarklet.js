/* ═══════════════════════════════════════════════════════════════════════
   Piso Libro — Bookmarklet WinLab
   ═══════════════════════════════════════════════════════════════════════
   Para instalar:
   1. Copia TODO este archivo desde "javascript:" hasta la última ");"
      (o usa la versión minificada en winlab-bookmarklet.min.js).
   2. En Firefox/Chrome → crea un favorito nuevo en la barra de marcadores.
   3. Ponle nombre: "📋 Sync censo WinLab".
   4. Pega el código en el campo URL.
   5. Guarda.

   Cómo usarlo:
   1. Abre WinLab, loguéate y ve a Reportes → Lista.
   2. Espera que carguen los resultados del día.
   3. Clic al bookmark "📋 Sync censo WinLab".
   4. Verás un toast arriba a la derecha con algo como:
      "✅ 37 de 46 pacientes del censo encontrados en WinLab · checkboxes activados"
   5. Ahora solo pica "Imprime Reportes" y descarga el PDF combinado.
   6. Arrastra ese PDF a piso-libro → Carga Masiva de Labs.

   Requisitos: tu Supabase del piso-libro tiene policies abiertas para anon,
   así que el bookmark puede leer el censo sin credenciales extras.
   ═══════════════════════════════════════════════════════════════════════ */

javascript:(async()=>{
  const SUPA_URL="https://vkxplmrzyqlamxpbtmes.supabase.co";
  const SUPA_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZreHBsbXJ6eXFsYW14cGJ0bWVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NTg1MjcsImV4cCI6MjA4NzUzNDUyN30.zChMOiKnxNv3pLyt2Fqi7zUh0ET5rn1a5L6S3RV1Q98";

  // ── Toast helper ─────────────────────────────────────────────────────
  const toast=(msg,color)=>{
    let t=document.getElementById("__pl_toast__");
    if(!t){t=document.createElement("div");t.id="__pl_toast__";
      t.style.cssText="position:fixed;top:20px;right:20px;z-index:99999;padding:14px 20px;border-radius:10px;font-family:-apple-system,sans-serif;font-size:14px;font-weight:600;color:#fff;box-shadow:0 8px 32px rgba(0,0,0,.25);max-width:420px;line-height:1.4;white-space:pre-line";
      document.body.appendChild(t);}
    t.style.background=color||"#0369a1";t.textContent=msg;t.style.display="block";
    clearTimeout(t._to);t._to=setTimeout(()=>t.style.display="none",8000);
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

  // ── 2. Build fast lookup: lastnames → patient ───────────────────────
  const normalize=s=>String(s||"").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ").trim();
  // Extract first 2 surnames (apellidos) from each census entry. Most nombres
  // are "APELLIDO1 APELLIDO2 NOMBRE1 NOMBRE2" style.
  const byKey=new Map();
  pts.forEach(p=>{
    const parts=normalize(p.nombre).split(" ").filter(Boolean);
    if(parts.length<2)return;
    const key=parts[0]+" "+parts[1]; // first two words = usually apellidos
    byKey.set(key,p);
    // Also index by first word alone (fallback)
    if(!byKey.has(parts[0]))byKey.set(parts[0],p);
  });

  // ── 3. Find patient rows in WinLab list (blue header rows) ──────────
  // WinLab renders each patient as a blue <tr> with apellidos+nombres and
  // then one or more yellow <tr> with report rows. We detect the blue rows
  // by the text content pattern and then check the following yellow rows.
  const allRows=Array.from(document.querySelectorAll("table tr"));
  let matched=0,missed=[],checkedBoxes=0;
  const seenPts=new Set();

  for(let i=0;i<allRows.length;i++){
    const row=allRows[i];
    const cells=Array.from(row.cells||[]).map(c=>normalize(c.innerText));
    if(cells.length<2)continue;

    // A patient header row has ≥4 cells, no barcode-looking numeric cell,
    // and usually matches pattern: [APELLIDO..., NOMBRE..., SEXO, FECHA NAC]
    const isHeader=cells.some(c=>c==="FEMENINO"||c==="MASCULINO");
    if(!isHeader)continue;

    // Find apellidos cell (usually the one before SEXO)
    let apellidos="",nombres="";
    for(let c=0;c<cells.length;c++){
      if(cells[c]==="FEMENINO"||cells[c]==="MASCULINO"){
        apellidos=cells[c-2]||"";
        nombres=cells[c-1]||"";
        break;
      }
    }
    if(!apellidos)continue;

    // Try to match: first, full "APELLIDO1 APELLIDO2"
    const apParts=apellidos.split(" ").filter(Boolean);
    let matchedPt=null;
    if(apParts.length>=2){
      matchedPt=byKey.get(apParts[0]+" "+apParts[1]);
    }
    if(!matchedPt&&apParts.length>=1){
      // Fallback: first apellido + first name
      const noParts=nombres.split(" ").filter(Boolean);
      matchedPt=byKey.get(apParts[0]+" "+(noParts[0]||""))||byKey.get(apParts[0]);
    }
    if(!matchedPt){missed.push(apellidos+" "+nombres);continue;}
    matched++;
    seenPts.add(matchedPt.exp||matchedPt.nombre);

    // Check all "Rep" checkboxes in the report rows that follow (until
    // next patient header).
    for(let j=i+1;j<allRows.length;j++){
      const nxt=allRows[j];
      const nxtCells=Array.from(nxt.cells||[]).map(c=>normalize(c.innerText));
      if(nxtCells.some(c=>c==="FEMENINO"||c==="MASCULINO"))break; // reached next patient
      const cb=nxt.querySelector('input[type="checkbox"]');
      if(cb&&!cb.checked){cb.click();checkedBoxes++;}
    }
  }

  // ── 4. Report ───────────────────────────────────────────────────────
  const censusCount=pts.length;
  const missingFromWinlab=pts.filter(p=>!seenPts.has(p.exp||p.nombre)).map(p=>p.nombre).slice(0,8);
  let msg=`✅ ${matched} pacientes del censo encontrados en WinLab\n📋 ${checkedBoxes} reportes seleccionados\n\n`;
  if(missingFromWinlab.length){
    msg+=`⚠️ Sin labs hoy (${censusCount-matched} de ${censusCount}):\n`+missingFromWinlab.map(n=>"  • "+n.split(" ").slice(0,3).join(" ")).join("\n");
    if(censusCount-matched>missingFromWinlab.length)msg+=`\n  … y ${censusCount-matched-missingFromWinlab.length} más`;
  }
  if(missed.length){msg+=`\n\n🔎 WinLab tiene pacientes que no son del censo: ${missed.length}`;}
  msg+=`\n\n👉 Ahora clic en "Imprime Reportes"`;
  toast(msg,matched?"#15803d":"#d97706");
})();
