import { useState, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../config/supabase'

// ─── Column name → patients table field ───────────────────────────────────────
const COL_MAP = {
  'CAMA':         'cama',
  'EXPEDIENTE':   'exp',
  'EXP':          'exp',
  'NOMBRE':       'nombre',
  'EDAD':         'edad',
  'DIAGNÓSTICO':  'dx',
  'DIAGNOSTICO':  'dx',
  'DX':           'dx',
  'ESPECIALIDAD': 'esp',
  'ADSCRITO':     'adscrito',
  'RESIDENTE':    'r_cargo',
  'INGRESO':      'ingreso',
  'DÍAS':         'dias',
  'DIAS':         'dias',
  'ESTADO':       'estado',
}

// Rows where the CAMA column contains a section title (used to tag patients, not to skip them)
// These rows don't have patient data themselves — but they set the section for rows below them
const SECTION_TITLE_PATTERNS = [
  /^RECUPER/i, /^MEDICINA INTERNA/i, /^TRANSPLANTE/i, /^TRASPLANTE/i,
  /^CIRUG[IÍ]A PEDI/i, /^EXTERNOS?$/i, /^AMBULATORIO/i,
  /^INGRESARON/i, /^MOVIMIENTOS/i, /^ALTAS/i, /^INGRESOS/i,
  /^CIRUG[IÍ]A GENERAL/i, /^NEUROCIRUGÍA/i, /^NEUROCIRUGÍA/i,
]

function isSectionTitle(cama) {
  return SECTION_TITLE_PATTERNS.some(re => re.test(cama.trim()))
}

// Normalize section label for storage
function normSection(raw) {
  const s = raw.trim().toUpperCase()
  if (/RECUPER/.test(s))          return 'RECUPERACIÓN'
  if (/MEDICINA INTERNA/.test(s)) return 'MEDICINA INTERNA'
  if (/TRANSPLANTE|TRASPLANTE/.test(s)) return 'TRANSPLANTES'
  if (/PEDIATR/.test(s))          return 'CIRUGÍA PEDIÁTRICA'
  if (/EXTERNO|AMBULAT/.test(s))  return 'EXTERNOS'
  return s
}

// ─── Parse Excel buffer into patient rows ─────────────────────────────────────
function parseExcel(buffer) {
  const wb   = XLSX.read(buffer, { type: 'array', cellDates: true })
  const ws   = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  // Find the header row: first row that has CAMA or EXPEDIENTE
  let headerRowIdx = -1
  let colIndex     = {}

  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map(c => String(c ?? '').trim().toUpperCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, ''))
    const hasCama = cells.some(c => c === 'CAMA')
    const hasExp  = cells.some(c => c === 'EXPEDIENTE' || c === 'EXP')
    if (hasCama || hasExp) {
      headerRowIdx = i
      cells.forEach((c, idx) => {
        // normalize accents for lookup
        const norm = c.normalize ? c : c
        const field = COL_MAP[c] ?? COL_MAP[rows[i][idx]?.toString().trim().toUpperCase()]
        if (field) colIndex[field] = idx
      })
      break
    }
  }

  if (headerRowIdx < 0) throw new Error('No se encontró fila de encabezados (CAMA / EXPEDIENTE)')
  if (!('cama' in colIndex)) throw new Error('Columna CAMA no encontrada')

  const patients   = []
  const errors     = []
  let   currentSection = 'PISO'   // default section = main floor

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row  = rows[i]
    const cama = String(row[colIndex.cama] ?? '').trim()

    if (!cama) continue

    // If this row is a section title, update current section and continue
    if (isSectionTitle(cama)) {
      currentSection = normSection(cama)
      continue
    }

    // Skip rows that look like footers/labels (no digits, very long)
    if (!/\d/.test(cama) && cama.length > 12) continue

    const pt = { cama, seccion: currentSection }

    for (const [field, idx] of Object.entries(colIndex)) {
      if (field === 'cama') continue
      let val = row[idx]
      if (val === undefined || val === null || val === '') continue

      // Date handling (INGRESO column)
      if (field === 'ingreso') {
        if (val instanceof Date) {
          pt[field] = val.toISOString().slice(0, 10)
        } else {
          const s = String(val).trim()
          // Try DD/MM/YYYY
          const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/)
          if (m) {
            const [, d, mo, y] = m
            const yr = y.length === 2 ? `20${y}` : y
            pt[field] = `${yr}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`
          } else {
            pt[field] = s
          }
        }
        continue
      }

      // Numeric fields
      if (field === 'edad' || field === 'dias') {
        const n = parseInt(val, 10)
        pt[field] = isNaN(n) ? null : n
        continue
      }

      pt[field] = String(val).trim()
    }

    if (!pt.nombre && !pt.exp) {
      errors.push({ row: i + 1, cama, msg: 'Sin nombre ni expediente' })
      continue
    }

    patients.push(pt)
  }

  return { patients, errors }
}

// ─── Compute diff against current DB patients ─────────────────────────────────
function computeDiff(incoming, existing) {
  const existingMap = {}
  existing.forEach(p => { existingMap[String(p.cama)] = p })

  const incomingMap = {}
  incoming.forEach(p => { incomingMap[String(p.cama)] = p })

  const added    = []
  const updated  = []
  const discharged = []

  incoming.forEach(pt => {
    const cur = existingMap[pt.cama]
    if (!cur) {
      added.push(pt)
    } else {
      const changes = {}
      for (const [k, v] of Object.entries(pt)) {
        const curVal = String(cur[k] ?? '').trim()
        const newVal = String(v ?? '').trim()
        if (curVal !== newVal && k !== 'cama') changes[k] = { from: curVal, to: newVal }
      }
      if (Object.keys(changes).length > 0) updated.push({ ...pt, _changes: changes })
    }
  })

  existing.forEach(p => {
    if (!incomingMap[String(p.cama)]) discharged.push(p)
  })

  return { added, updated, discharged }
}

// ─── Diff row component ───────────────────────────────────────────────────────
function DiffRow({ pt, type }) {
  const bg = type === 'add' ? '#34D39910'
           : type === 'update' ? '#F59E0B10'
           : '#EF444410'
  const border = type === 'add' ? '#34D399'
               : type === 'update' ? '#F59E0B'
               : '#EF4444'
  const tag = type === 'add' ? 'NUEVO' : type === 'update' ? 'CAMBIO' : 'ALTA'
  const tagBg = type === 'add' ? '#34D39920' : type === 'update' ? '#F59E0B20' : '#EF444420'

  return (
    <div className="flex items-start gap-2 px-3 py-1.5 text-xs font-mono"
         style={{ background: bg, borderLeft: `2px solid ${border}` }}>
      <span className="flex-shrink-0 text-[9px] px-1.5 py-0.5 rounded font-bold mt-0.5"
            style={{ background: tagBg, color: border }}>
        {tag}
      </span>
      <div className="flex-1 min-w-0">
        <span className="text-[#E4E4E7]">{pt.cama}</span>
        <span className="text-[#6B7280] mx-1">·</span>
        <span className="text-[#A1A1AA]">{pt.nombre ?? pt.cama}</span>
        {pt.seccion && pt.seccion !== 'PISO' && (
          <span className="ml-1.5 text-[9px] font-mono px-1.5 py-0.5 rounded"
                style={{ background:'#3B82F620', color:'#3B82F6' }}>
            {pt.seccion}
          </span>
        )}
        {pt._changes && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {Object.entries(pt._changes).map(([k, { from, to }]) => (
              <span key={k} className="text-[9px] text-[#6B7280]">
                <span className="text-[#3f3f46]">{k}:</span>{' '}
                <span className="line-through text-[#EF4444]">{from || '—'}</span>
                {' → '}
                <span className="text-[#34D399]">{to || '—'}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── ImportModal ──────────────────────────────────────────────────────────────
export function ImportModal({ currentPatients, onClose, onImported }) {
  const [step,     setStep]     = useState('pick')   // pick | preview | importing | done | error
  const [diff,     setDiff]     = useState(null)
  const [parsed,   setParsed]   = useState([])
  const [parseErr, setParseErr] = useState([])
  const [message,  setMessage]  = useState('')
  const [progress, setProgress] = useState(0)
  const [deleteDischarged, setDeleteDischarged] = useState(false)
  const fileRef = useRef()

  const handleFile = useCallback(async (file) => {
    if (!file) return
    setStep('pick')
    setMessage('')
    try {
      const buf = await file.arrayBuffer()
      const { patients, errors } = parseExcel(new Uint8Array(buf))
      if (patients.length === 0) throw new Error('El archivo no tiene pacientes válidos')
      const d = computeDiff(patients, currentPatients)
      setParsed(patients)
      setParseErr(errors)
      setDiff(d)
      setStep('preview')
    } catch (e) {
      setMessage(e.message)
      setStep('error')
    }
  }, [currentPatients])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  async function confirmImport() {
    setStep('importing')
    setProgress(0)
    try {
      const total = parsed.length + (deleteDischarged ? diff.discharged.length : 0)
      let done = 0

      // Upsert in batches of 50
      const BATCH = 50
      for (let i = 0; i < parsed.length; i += BATCH) {
        const batch = parsed.slice(i, i + BATCH)
        const { error } = await supabase
          .from('patients')
          .upsert(batch, { onConflict: 'cama' })
        if (error) throw error
        done += batch.length
        setProgress(Math.round((done / total) * 100))
      }

      // Optionally delete discharged patients
      if (deleteDischarged && diff.discharged.length > 0) {
        const camas = diff.discharged.map(p => p.cama)
        const { error } = await supabase
          .from('patients')
          .delete()
          .in('cama', camas)
        if (error) throw error
        done += camas.length
        setProgress(100)
      }

      setMessage(`✓ ${diff.added.length} nuevos · ${diff.updated.length} actualizados · ${deleteDischarged ? diff.discharged.length : 0} dados de alta`)
      setStep('done')
      onImported()
    } catch (e) {
      setMessage(e.message)
      setStep('error')
    }
  }

  const totalChanges = diff ? diff.added.length + diff.updated.length + diff.discharged.length : 0

  return (
    <div className="fixed inset-0 z-[100] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
         onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-[#0f0f10] border border-[#1f1f22] rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#1f1f22]">
          <span className="font-mono text-xs text-[#D4A373] uppercase tracking-widest">
            Importar Censo · Excel
          </span>
          <button onClick={onClose} className="text-[#6B7280] hover:text-[#F4F4F5] text-sm">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto">

          {/* Step: pick file */}
          {(step === 'pick' || step === 'error') && (
            <div className="p-6 flex flex-col gap-4">
              <div
                className="border-2 border-dashed border-[#1f1f22] rounded-xl p-10 flex flex-col items-center gap-3 cursor-pointer hover:border-[#D4A37360] transition-colors"
                onDrop={handleDrop}
                onDragOver={e => e.preventDefault()}
                onClick={() => fileRef.current?.click()}
              >
                <span className="text-3xl">📋</span>
                <p className="text-sm text-[#A1A1AA] font-mono text-center">
                  Arrastra el Excel aquí<br />
                  <span className="text-[#6B7280] text-xs">o haz clic para seleccionarlo</span>
                </p>
                <span className="text-[10px] font-mono text-[#3f3f46]">.xlsx únicamente</span>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={e => handleFile(e.target.files[0])}
              />
              {step === 'error' && message && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
                  <p className="text-xs font-mono text-red-400">{message}</p>
                </div>
              )}
            </div>
          )}

          {/* Step: preview diff */}
          {step === 'preview' && diff && (
            <div className="flex flex-col">
              {/* Summary bar */}
              <div className="flex items-center gap-4 px-5 py-3 border-b border-[#1f1f22] flex-wrap">
                <span className="text-xs font-mono text-[#34D399]">+{diff.added.length} nuevos</span>
                <span className="text-xs font-mono text-[#F59E0B]">~ {diff.updated.length} cambios</span>
                <span className="text-xs font-mono text-[#EF4444]">−{diff.discharged.length} altas</span>
                <span className="text-xs font-mono text-[#6B7280] ml-auto">{parsed.length} pacientes en total</span>
              </div>

              {/* Parse errors */}
              {parseErr.length > 0 && (
                <div className="px-5 py-2 border-b border-[#1f1f22]">
                  <p className="text-[10px] font-mono text-[#F59E0B] uppercase tracking-widest mb-1">
                    Filas con advertencias ({parseErr.length})
                  </p>
                  {parseErr.map((e, i) => (
                    <p key={i} className="text-[10px] font-mono text-[#6B7280]">
                      Fila {e.row} · cama {e.cama} · {e.msg}
                    </p>
                  ))}
                </div>
              )}

              {/* No changes */}
              {totalChanges === 0 && (
                <div className="px-5 py-8 text-center">
                  <p className="text-sm font-mono text-[#6B7280]">El censo ya está al día — sin cambios detectados</p>
                </div>
              )}

              {/* Diff list */}
              <div className="flex flex-col divide-y divide-[#1f1f22]">
                {diff.added.map(pt    => <DiffRow key={pt.cama} pt={pt} type="add"      />)}
                {diff.updated.map(pt  => <DiffRow key={pt.cama} pt={pt} type="update"   />)}
                {diff.discharged.map(pt => <DiffRow key={pt.cama} pt={pt} type="discharge" />)}
              </div>

              {/* Discharged option */}
              {diff.discharged.length > 0 && (
                <div className="px-5 py-3 border-t border-[#1f1f22] flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="del-discharged"
                    checked={deleteDischarged}
                    onChange={e => setDeleteDischarged(e.target.checked)}
                    className="accent-[#D4A373]"
                  />
                  <label htmlFor="del-discharged" className="text-xs font-mono text-[#A1A1AA] cursor-pointer">
                    Eliminar pacientes dados de alta de la base de datos
                  </label>
                </div>
              )}
            </div>
          )}

          {/* Step: importing */}
          {step === 'importing' && (
            <div className="p-8 flex flex-col items-center gap-4">
              <div className="w-full bg-[#1f1f22] rounded-full h-2 overflow-hidden">
                <div className="h-full bg-[#D4A373] transition-all duration-300 rounded-full"
                     style={{ width: `${progress}%` }} />
              </div>
              <p className="text-xs font-mono text-[#6B7280]">Subiendo a Supabase… {progress}%</p>
            </div>
          )}

          {/* Step: done */}
          {step === 'done' && (
            <div className="p-8 flex flex-col items-center gap-3">
              <span className="text-3xl">✓</span>
              <p className="text-sm font-mono text-[#34D399]">{message}</p>
              <p className="text-xs font-mono text-[#6B7280]">El censo se actualizó correctamente</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#1f1f22]">
          {step === 'preview' && (
            <>
              <button onClick={onClose}
                      className="text-xs font-mono text-[#6B7280] hover:text-[#F4F4F5] px-4 py-1.5 rounded border border-[#1f1f22]">
                Cancelar
              </button>
              <button
                onClick={confirmImport}
                disabled={totalChanges === 0}
                className="text-xs font-mono px-4 py-1.5 rounded border transition-all disabled:opacity-30"
                style={{ background:'#D4A37320', borderColor:'#D4A37360', color:'#D4A373' }}
              >
                Confirmar importación
              </button>
            </>
          )}
          {(step === 'done' || step === 'error') && (
            <button onClick={onClose}
                    className="text-xs font-mono px-4 py-1.5 rounded border border-[#1f1f22] text-[#6B7280]">
              Cerrar
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
