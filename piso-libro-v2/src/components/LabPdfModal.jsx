import { useState, useCallback, useRef } from 'react'
import { supabase } from '../config/supabase'

// ─── ALIAS: same map as PatientCard ──────────────────────────────────────────
const ALIAS = {
  leucocitos:'leu', leucos:'leu', globulos_blancos:'leu', gb:'leu', wbc:'leu',
  cuenta_de_leucocitos:'leu', cel_blancas:'leu', glóbulos_blancos:'leu',
  hemoglobina:'hb', hgb:'hb', hb:'hb',
  plaquetas:'plaq', plt:'plaq', trombocitos:'plaq', cuenta_plaquetaria:'plaq',
  glucosa:'glu', glucose:'glu', glucosa_en_suero:'glu', glucosa_serica:'glu',
  urea:'urea', bun:'urea', urea_serica:'urea', nitrogeno_ureico:'urea',
  creatinina:'cr', creatinine:'cr', creatinina_serica:'cr',
  sodio:'na', sodium:'na', sodio_serico:'na', na:'na',
  potasio:'k', potassium:'k', potasio_serico:'k',
  lactato:'lac', lactate:'lac', lactico:'lac', lactato_serico:'lac',
  acido_lactico:'lac', acido_lactico_lactato:'lac',
}

const LAB_LABELS = { hb:'Hb', leu:'Leu', plaq:'Plaq', glu:'Glu', urea:'Urea', cr:'Cr', na:'Na', k:'K', lac:'Lac' }

function normalizeKey(raw) {
  return raw.toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

function resolveAlias(raw) {
  const k = normalizeKey(raw)
  return ALIAS[k] ?? k
}

// ─── PDF parser ───────────────────────────────────────────────────────────────
async function parsePdf(file) {
  // Dynamic import so the ~1MB chunk only loads when the modal opens
  const pdfjsLib = await import('pdfjs-dist')
  const workerUrl = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url)
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl.href

  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

  // Collect all text items across all pages with their positions
  const allItems = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page  = await pdf.getPage(p)
    const tc    = await page.getTextContent()
    const vp    = page.getViewport({ scale: 1 })
    for (const item of tc.items) {
      if (!item.str.trim()) continue
      allItems.push({
        text: item.str.trim(),
        x: item.transform[4],
        // Flip y so top=large, bottom=small (PDF y is bottom-up)
        y: Math.round((vp.height - item.transform[5]) * 2) / 2,
        page: p,
      })
    }
  }

  // Group items into logical rows: same page + y within 4pt
  allItems.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
  const rows = []
  for (const item of allItems) {
    const last = rows[rows.length - 1]
    if (last && last.page === item.page && Math.abs(last.y - item.y) <= 4) {
      last.items.push(item)
    } else {
      rows.push({ page: item.page, y: item.y, items: [item] })
    }
  }
  // Sort items within each row left→right
  rows.forEach(r => r.items.sort((a, b) => a.x - b.x))

  // ── Extract patient info ──────────────────────────────────────────────────
  let exp = null, nombre = null, fecha = null
  const fullText = allItems.map(i => i.text).join(' ')

  const expMatch = fullText.match(/(?:EXPEDIENTE|EXP(?:\.|\s*No\.?)?)[:\s#]*([0-9]+-?[0-9]+)/i)
  if (expMatch) exp = expMatch[1]

  const nombreMatch = fullText.match(/(?:PACIENTE|NOMBRE|SR\.?A?\.?)[:\s]+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s,\.]+?)(?:\s{2,}|\n|EXP|EDAD|FECHA|SEXO|$)/i)
  if (nombreMatch) nombre = nombreMatch[1].trim()

  const fechaMatch = fullText.match(/(?:FECHA(?:\s+DE\s+(?:TOMA|REPORTE|RESULTADO))?)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)
  if (fechaMatch) fecha = fechaMatch[1]

  // ── Extract lab values ────────────────────────────────────────────────────
  // Strategy: for each row, if first item is a study name (alphabetic, >= 3 chars)
  // and another item in the row parses to a clean number, treat as lab row.
  const labsRaw = {}  // raw name → value
  const SKIP_WORDS = new Set([
    'RESULTADO','RESULTADOS','ANALISIS','ANÁLISIS','EXAMEN','PRUEBA','UNIDAD','UNIDADES',
    'REFERENCIA','RANGO','VALOR','VALORES','FECHA','HORA','PAGINA','PÁGINA','IMPRESO',
    'HOSPITAL','LABORATORIO','PACIENTE','NOMBRE','EXPEDIENTE','SOLICITUD','MEDICO',
    'ESTUDIO','MUESTRA','FOLIO','HOJA','SISTEMA','REPORTE',
  ])

  for (const row of rows) {
    const texts = row.items.map(i => i.text)
    if (texts.length < 2) continue

    const studyName = texts[0]
    if (studyName.length < 3) continue
    if (/^\d/.test(studyName)) continue   // starts with number = not a study name
    if (SKIP_WORDS.has(studyName.toUpperCase().normalize('NFD').replace(/\p{Diacritic}/gu, ''))) continue

    // Find first numeric value in the row (not in column 0)
    for (let i = 1; i < texts.length; i++) {
      const candidate = texts[i].replace(',', '.')
      const n = parseFloat(candidate)
      if (!isNaN(n) && n >= 0 && n < 1_000_000 && /^[\d.,]+$/.test(texts[i])) {
        labsRaw[studyName] = n
        break
      }
    }
  }

  // ── Resolve through ALIAS map ─────────────────────────────────────────────
  const labs = {}
  for (const [name, val] of Object.entries(labsRaw)) {
    const key = resolveAlias(name)
    // Keep all resolved keys (known short key or raw normalized)
    if (!(key in labs)) labs[key] = val
  }

  return { exp, nombre, fecha, labs, labsRaw }
}

// ─── LabPdfModal ──────────────────────────────────────────────────────────────
export function LabPdfModal({ currentPatients, onClose, onImported }) {
  const [step,       setStep]       = useState('drop')  // drop | parsing | preview | saving | done
  const [error,      setError]      = useState(null)
  const [parsed,     setParsed]     = useState(null)    // {exp, nombre, fecha, labs, labsRaw}
  const [matched,    setMatched]    = useState(null)    // patient row or null
  const [manualExp,  setManualExp]  = useState('')
  const fileRef = useRef(null)

  const KNOWN_KEYS = new Set(Object.keys(LAB_LABELS))

  // ── File selected / dropped ─────────────────────────────────────────────
  const handleFile = useCallback(async (file) => {
    if (!file || file.type !== 'application/pdf') {
      setError('El archivo debe ser un PDF de WinLab.')
      return
    }
    setError(null)
    setStep('parsing')
    try {
      const result = await parsePdf(file)
      setParsed(result)

      // Try to auto-match patient
      const expNorm = (result.exp ?? '').replace(/-/g, '').toLowerCase()
      const nombreNorm = (result.nombre ?? '').toLowerCase()
      const hit = currentPatients.find(p => {
        if (!p.exp) return false
        const pExp = String(p.exp).replace(/-/g, '').toLowerCase()
        if (expNorm && pExp === expNorm) return true
        if (nombreNorm && p.nombre) {
          const pNom = String(p.nombre).toLowerCase()
          const words = nombreNorm.split(/\s+/).filter(w => w.length > 3)
          return words.filter(w => pNom.includes(w)).length >= 2
        }
        return false
      })
      setMatched(hit ?? null)
      setStep('preview')
    } catch (e) {
      setError(`Error al leer el PDF: ${e.message}`)
      setStep('drop')
    }
  }, [currentPatients])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    handleFile(file)
  }, [handleFile])

  // ── Confirm save ─────────────────────────────────────────────────────────
  async function save() {
    const target = matched ?? currentPatients.find(p => {
      const pExp = String(p.exp ?? '').replace(/-/g, '').toLowerCase()
      return pExp === manualExp.replace(/-/g, '').toLowerCase()
    })
    if (!target) { setError('No se encontró el paciente. Verifica el expediente.'); return }

    setStep('saving')
    const today = new Date().toISOString().slice(0, 10)
    const newEntry = {
      exp:       target.exp,
      fecha:     parsed.fecha ?? today,
      scraped_at: new Date().toISOString(),
      labs_manual_import: true,
      reportes: [{ valores: Object.entries(parsed.labsRaw).map(([estudio, valor]) => ({ estudio, valor: String(valor) })) }],
    }

    const prevHistory = Array.isArray(target.labs_history) ? target.labs_history : []
    const labs_history = [newEntry, ...prevHistory].slice(0, 10)

    const { error: err } = await supabase
      .from('patients')
      .update({ labs_history, labs_manual: parsed.labs })
      .eq('cama', target.cama)

    if (err) { setError(err.message); setStep('preview'); return }
    setStep('done')
    setTimeout(() => { onImported(); onClose() }, 1200)
  }

  return (
    <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
         onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-[#0f0f10] border border-[#1f1f22] rounded-xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f22]">
          <span className="font-mono text-xs text-[#D4A373] uppercase tracking-widest">Importar Labs PDF</span>
          <button onClick={onClose} className="text-xs font-mono text-[#6B7280] hover:text-[#F4F4F5]">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">

          {/* DROP ZONE */}
          {step === 'drop' && (
            <div
              onDrop={onDrop} onDragOver={e => e.preventDefault()}
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-[#2a2a2e] rounded-lg p-10 text-center cursor-pointer hover:border-[#D4A37360] transition-all"
            >
              <input ref={fileRef} type="file" accept=".pdf" className="hidden"
                     onChange={e => handleFile(e.target.files[0])} />
              <p className="text-[#6B7280] font-mono text-sm mb-1">Arrastra o haz clic</p>
              <p className="text-[#3f3f46] font-mono text-xs">PDF de resultados WinLab</p>
            </div>
          )}

          {/* PARSING */}
          {step === 'parsing' && (
            <div className="text-center py-10">
              <span className="text-2xl text-[#D4A373] animate-spin inline-block">↻</span>
              <p className="text-[#6B7280] font-mono text-xs mt-3">Leyendo PDF…</p>
            </div>
          )}

          {/* PREVIEW */}
          {step === 'preview' && parsed && (
            <div className="flex flex-col gap-4">
              {/* Patient match */}
              <div className="bg-[#151516] border border-[#1f1f22] rounded-lg p-3">
                <p className="text-[9px] font-mono text-[#6B7280] uppercase tracking-widest mb-2">Paciente detectado</p>
                {parsed.exp && <p className="text-xs font-mono text-[#A1A1AA]">Exp: <span className="text-[#F4F4F5]">{parsed.exp}</span></p>}
                {parsed.nombre && <p className="text-xs font-mono text-[#A1A1AA]">Nombre: <span className="text-[#F4F4F5]">{parsed.nombre}</span></p>}
                {parsed.fecha && <p className="text-xs font-mono text-[#A1A1AA]">Fecha: <span className="text-[#F4F4F5]">{parsed.fecha}</span></p>}

                {matched ? (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[10px] font-mono text-[#34D399]">✓ Coincide con</span>
                    <span className="text-[10px] font-mono text-[#F4F4F5]">{matched.cama} — {matched.nombre}</span>
                  </div>
                ) : (
                  <div className="mt-2">
                    <p className="text-[10px] font-mono text-[#F59E0B] mb-1">No se encontró coincidencia automática. Escribe el expediente:</p>
                    <input
                      value={manualExp}
                      onChange={e => setManualExp(e.target.value)}
                      placeholder="ej. 26-06437"
                      className="w-full bg-[#0a0a0b] border border-[#1f1f22] rounded text-xs font-mono text-[#F4F4F5] px-2 py-1 focus:outline-none focus:border-[#D4A373]"
                    />
                  </div>
                )}
              </div>

              {/* Extracted labs */}
              <div className="bg-[#151516] border border-[#1f1f22] rounded-lg p-3">
                <p className="text-[9px] font-mono text-[#6B7280] uppercase tracking-widest mb-2">
                  Valores extraídos ({Object.keys(parsed.labsRaw).length})
                </p>

                {/* Known labs (panel) */}
                {Object.entries(parsed.labs).filter(([k]) => KNOWN_KEYS.has(k)).length > 0 && (
                  <>
                    <p className="text-[9px] font-mono text-[#6B7280] mb-1">Panel principal</p>
                    <div className="flex flex-wrap gap-2 mb-3">
                      {Object.entries(parsed.labs)
                        .filter(([k]) => KNOWN_KEYS.has(k))
                        .map(([k, v]) => (
                          <span key={k} className="bg-[#0f0f10] border border-[#1f1f22] rounded px-2 py-0.5 text-[11px] font-mono">
                            <span className="text-[#6B7280]">{LAB_LABELS[k] ?? k} </span>
                            <span className="text-[#34D399]">{v}</span>
                          </span>
                        ))}
                    </div>
                  </>
                )}

                {/* All extracted (raw) */}
                <p className="text-[9px] font-mono text-[#6B7280] mb-1">Todos los valores</p>
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full text-[10px] font-mono">
                    <tbody>
                      {Object.entries(parsed.labsRaw).map(([name, val]) => (
                        <tr key={name} className="border-b border-[#1f1f22]">
                          <td className="py-0.5 text-[#A1A1AA] pr-2">{name}</td>
                          <td className="py-0.5 text-[#F4F4F5] text-right">{val}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {Object.keys(parsed.labsRaw).length === 0 && (
                  <p className="text-[#F59E0B] text-xs font-mono">No se detectaron valores numéricos. El formato del PDF puede ser distinto.</p>
                )}
              </div>
            </div>
          )}

          {/* SAVING */}
          {step === 'saving' && (
            <div className="text-center py-10">
              <span className="text-2xl text-[#D4A373] animate-spin inline-block">↻</span>
              <p className="text-[#6B7280] font-mono text-xs mt-3">Guardando…</p>
            </div>
          )}

          {/* DONE */}
          {step === 'done' && (
            <div className="text-center py-10">
              <p className="text-3xl">✓</p>
              <p className="text-[#34D399] font-mono text-sm mt-2">Labs guardados</p>
            </div>
          )}

          {error && (
            <p className="mt-3 text-[#EF4444] font-mono text-xs">{error}</p>
          )}
        </div>

        {/* Footer */}
        {step === 'preview' && (
          <div className="flex gap-2 px-4 py-3 border-t border-[#1f1f22]">
            <button onClick={() => { setStep('drop'); setParsed(null); setMatched(null); setManualExp('') }}
                    className="flex-1 text-xs font-mono py-1.5 rounded border border-[#1f1f22] text-[#6B7280] hover:border-[#6B7280]">
              Otro PDF
            </button>
            <button
              onClick={save}
              disabled={Object.keys(parsed?.labsRaw ?? {}).length === 0 || (!matched && !manualExp)}
              className="flex-1 text-xs font-mono py-1.5 rounded border transition-all disabled:opacity-30"
              style={{ borderColor: '#D4A37360', color: '#D4A373', background: '#D4A37310' }}
            >
              Guardar labs
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
