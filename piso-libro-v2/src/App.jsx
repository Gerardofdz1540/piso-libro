import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from './config/supabase'
import { PatientCard } from './components/PatientCard'
import { ImportModal } from './components/ImportModal'
import { LabPdfModal } from './components/LabPdfModal'

// ─── Transform a winlab_labs row into a flat {labKey: value} object ──────────
// winlab stores rows as { __cells: [labName, value, range, unit], __hasLink }
// We find the column indices from the headers array and build a flat map
function transformWinlabRow(wlRow) {
  const data    = wlRow.data ?? {}
  const headers = (data.headers ?? []).map(h => String(h ?? '').toLowerCase()
    .replace(/[áéíóú]/g, c => ({á:'a',é:'e',í:'i',ó:'o',ú:'u'})[c] ?? c))
  const ni = Math.max(0, headers.findIndex(h => h.includes('analisis') || h.includes('prueba') || h.includes('examen')))
  const vi = headers.findIndex(h => h.includes('resultado') || h.includes('result') || h === 'valor')
  const valueIdx = vi >= 0 ? vi : 1

  const labValues = {}
  ;(data.reportes ?? []).forEach(row => {
    // Path 1: drill-down produced {estudio, valor} pairs
    if (Array.isArray(row.valores) && row.valores.length > 0) {
      row.valores.forEach(v => {
        const name = String(v.estudio ?? v.nombre ?? '').trim()
        if (!name) return
        const val = parseFloat(String(v.valor ?? v.resultado ?? '').replace(',', '.'))
        if (!isNaN(val)) labValues[name] = val
      })
      return
    }
    // Path 2: list-page __cells fallback
    const cells  = row.__cells ?? []
    const nameRaw = cells[ni]
    const valRaw  = cells[valueIdx]
    if (!nameRaw) return
    const val = parseFloat(String(valRaw ?? '').replace(',', '.'))
    if (!isNaN(val)) labValues[String(nameRaw).trim()] = val
  })

  return { fecha: wlRow.fecha ?? null, scraped_at: wlRow.scraped_at ?? null, ...labValues }
}

// ─── Ward bed list (bed numbers that always show, even if empty) ──────────────
const WARD_BEDS = [
  '3-150','3-151','3-152','3-153','3-154','3-155',
  '3-156','3-157','3-158','3-159','3-160','3-161',
  '3-162','3-163','3-164','3-165','3-166','3-167',
  '3-168','3-169','3-170','3-171','3-172','3-173',
  '3-174','3-175','3-176','3-177','3-178','3-179',
  '3-180','3-181','3-182','3-183','3-184','3-185',
]

const PRIMARY_SERVICES = ['CG', 'CT', 'CCR', 'CV', 'GASTRO']
const ESP_COLOR = {
  CG: '#D4A373', CCR: '#a78bfa', CV: '#60a5fa',
  CT: '#34d399', CPR: '#f472b6', URO: '#fbbf24', NCX: '#f87171',
  GASTRO: '#fb923c',
}

// ─── BedNavigator ─────────────────────────────────────────────────────────────
function BedNavigator({ patients }) {
  if (!patients.length) return null
  function scrollToBed(cama) {
    const el = document.getElementById(`bed-${String(cama).replace(/\s/g, '-')}`)
    if (!el) return
    const y = el.getBoundingClientRect().top + window.scrollY - 56
    window.scrollTo({ top: y, behavior: 'smooth' })
  }
  return (
    <nav className="sticky top-0 z-50 bg-[#050505] border-b border-[#1f1f22] overflow-x-auto"
         style={{ scrollbarWidth: 'none' }}>
      <div className="flex items-center gap-1 px-4 py-1.5 min-w-max">
        {patients.map((p) => {
          const color = ESP_COLOR[p.esp] ?? '#6B7280'
          const done  = p.nota_hecha
          return (
            <button
              key={p.cama}
              onClick={() => scrollToBed(p.cama)}
              title={`${p.nombre ?? ''} — ${p.dx ?? ''}`}
              className="rounded-full px-2.5 py-0.5 text-xs font-mono font-medium whitespace-nowrap flex-shrink-0 transition-all"
              style={{
                border: `1px solid ${color}50`,
                color: done ? '#6B7280' : color,
                background: done ? '#ffffff08' : 'transparent',
                textDecoration: done ? 'line-through' : 'none',
              }}
            >
              {p.cama}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function Sidebar({ patients, isWeekendMode, onToggleWeekend, onSync, syncStatus, search, onSearch, onImport, onImportLabs }) {
  const owned      = patients.filter(p => PRIMARY_SERVICES.includes(p.esp ?? ''))
  const doneCount  = owned.filter(p => p.nota_hecha).length
  const totalCount = owned.length

  return (
    <aside className="hidden md:flex flex-col w-52 min-h-screen border-r border-[#1f1f22] bg-[#0a0a0b] px-3 py-4 gap-4 sticky top-0 self-start">
      {/* Logo */}
      <div className="px-1 mb-1">
        <span className="text-[#D4A373] font-mono text-sm font-bold tracking-widest">PISO·LIBRO</span>
      </div>

      {/* FDS tracker */}
      {isWeekendMode && (
        <div className="bg-[#151516] border border-[#1f1f22] rounded-lg p-3">
          <p className="text-[10px] font-mono text-[#6B7280] uppercase tracking-widest mb-2">Notas FDS</p>
          <div className="flex items-end gap-1">
            <span className="text-2xl font-mono font-bold text-[#D4A373]">{doneCount}</span>
            <span className="text-sm font-mono text-[#6B7280] mb-0.5">/ {totalCount}</span>
          </div>
          {totalCount > 0 && (
            <div className="mt-2 h-1 bg-[#1f1f22] rounded-full overflow-hidden">
              <div
                className="h-full bg-[#D4A373] rounded-full transition-all"
                style={{ width: `${(doneCount / totalCount) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Search */}
      <input
        value={search}
        onChange={e => onSearch(e.target.value)}
        placeholder="Buscar…"
        className="w-full bg-[#151516] border border-[#1f1f22] rounded text-xs text-[#F4F4F5] placeholder-[#6B7280] px-3 py-1.5 focus:outline-none focus:border-[#D4A373]"
      />

      {/* Census summary */}
      <div className="bg-[#151516] border border-[#1f1f22] rounded-lg p-3">
        <p className="text-[10px] font-mono text-[#6B7280] uppercase tracking-widest mb-2">Censo</p>
        <div className="flex flex-col gap-1">
          {Object.entries(
            patients.reduce((acc, p) => {
              const k = p.esp ?? '—'
              acc[k] = (acc[k] ?? 0) + 1
              return acc
            }, {})
          ).map(([esp, count]) => (
            <div key={esp} className="flex justify-between items-center">
              <span className="text-xs font-mono" style={{ color: ESP_COLOR[esp] ?? '#6B7280' }}>{esp}</span>
              <span className="text-xs font-mono text-[#6B7280]">{count}</span>
            </div>
          ))}
        </div>
        <div className="border-t border-[#1f1f22] mt-2 pt-2 flex justify-between">
          <span className="text-[10px] font-mono text-[#6B7280]">Total</span>
          <span className="text-xs font-mono text-[#F4F4F5]">{patients.length}</span>
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-2">
        {/* Import labs PDF */}
        <button
          onClick={onImportLabs}
          className="w-full text-xs font-mono py-1.5 rounded border border-[#1f1f22] text-[#6B7280] hover:border-[#34D39960] hover:text-[#34D399] transition-all"
        >
          ⊕ Labs PDF
        </button>

        {/* Import census */}
        <button
          onClick={onImport}
          className="w-full text-xs font-mono py-1.5 rounded border border-[#1f1f22] text-[#6B7280] hover:border-[#D4A37360] hover:text-[#D4A373] transition-all"
        >
          ↑ Importar censo
        </button>

        {/* Weekend toggle */}
        <button
          onClick={onToggleWeekend}
          className="w-full text-xs font-mono py-1.5 rounded border transition-all"
          style={isWeekendMode
            ? { background: '#D4A37320', borderColor: '#D4A37360', color: '#D4A373' }
            : { background: 'transparent', borderColor: '#1f1f22', color: '#6B7280' }}
        >
          {isWeekendMode ? '⬡ MODO FDS ON' : '⬡ MODO FDS'}
        </button>

        {/* Sync */}
        <button
          onClick={onSync}
          disabled={syncStatus === 'syncing'}
          className="w-full text-xs font-mono py-1.5 rounded border border-[#1f1f22] text-[#6B7280] hover:border-[#6B7280] transition-all disabled:opacity-40"
        >
          {syncStatus === 'syncing' ? '↻ Sincronizando…' : syncStatus === 'error' ? '✕ Error' : '↺ Sync'}
        </button>
      </div>
    </aside>
  )
}

// ─── Mobile Header ─────────────────────────────────────────────────────────────
function MobileHeader({ syncStatus, onSync, search, onSearch, onImport }) {
  return (
    <header className="md:hidden sticky top-0 z-50 bg-[#050505] border-b border-[#1f1f22] px-4 py-2 flex items-center gap-2">
      <span className="text-[#D4A373] font-mono text-xs font-bold tracking-widest flex-shrink-0">PISO·LIBRO</span>
      <input
        value={search}
        onChange={e => onSearch(e.target.value)}
        placeholder="Buscar paciente…"
        className="flex-1 bg-[#151516] border border-[#1f1f22] rounded text-xs text-[#F4F4F5] placeholder-[#6B7280] px-2 py-1 focus:outline-none focus:border-[#D4A373]"
      />
      <button onClick={onImport}
              className="text-[#6B7280] text-xs font-mono flex-shrink-0">↑</button>
      <button onClick={onSync} disabled={syncStatus === 'syncing'}
              className="text-[#6B7280] text-xs font-mono disabled:opacity-40 flex-shrink-0">
        {syncStatus === 'syncing' ? '↻' : '↺'}
      </button>
    </header>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [patients,      setPatients]     = useState([])
  const [winlab,        setWinlab]       = useState({})  // exp → [transformed row]
  const [loading,       setLoading]      = useState(true)
  const [error,         setError]        = useState(null)
  const [syncStatus,    setSyncStatus]   = useState('idle')
  const [search,        setSearch]       = useState('')
  const [isWeekendMode, setWeekendMode]  = useState(() =>
    localStorage.getItem('pl_weekend_mode') === '1'
  )
  const [showImport,    setShowImport]    = useState(false)
  const [showLabPdf,   setShowLabPdf]    = useState(false)
  const channelRef = useRef(null)

  // ── Load all patients ──────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setSyncStatus('syncing')
    try {
      const { data, error: err } = await supabase
        .from('patients')
        .select('*')
        .order('cama')
      if (err) throw err
      setPatients(data ?? [])

      // Fetch winlab_labs and build exp→[rows] map (bridge until scraper writes to patients.labs_history)
      const { data: wl } = await supabase
        .from('winlab_labs')
        .select('exp,fecha,scraped_at,data')
        .order('scraped_at', { ascending: false })
        .limit(500)
      const wlByExp = {}
      ;(wl ?? []).forEach(row => {
        const exp = String(row.exp ?? '').trim()
        if (!exp) return
        if (!wlByExp[exp]) wlByExp[exp] = []
        if (wlByExp[exp].length < 5) wlByExp[exp].push(transformWinlabRow(row))
      })
      setWinlab(wlByExp)

      setSyncStatus('ok')
      setError(null)
    } catch (e) {
      setSyncStatus('error')
      setError(e.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Realtime subscription ──────────────────────────────────────────────────
  useEffect(() => {
    loadAll()

    if (channelRef.current) supabase.removeChannel(channelRef.current)

    const ch = supabase
      .channel('patients-v4')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'patients' }, (p) => {
        if (p.eventType === 'DELETE') {
          setPatients(prev => prev.filter(r => r.id !== p.old.id))
          return
        }
        const row = p.new
        setPatients(prev => {
          const i = prev.findIndex(r => r.id === row.id)
          if (i >= 0) { const n = [...prev]; n[i] = row; return n }
          return [...prev, row].sort((a, b) =>
            String(a.cama).localeCompare(String(b.cama), 'es', { numeric: true }))
        })
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'winlab_labs' }, (p) => {
        const row = p.new
        const exp = String(row.exp ?? '').trim()
        if (!exp) return
        const transformed = transformWinlabRow(row)
        setWinlab(prev => ({
          ...prev,
          [exp]: [transformed, ...(prev[exp] ?? [])].slice(0, 5),
        }))
      })
      .subscribe()

    channelRef.current = ch
    return () => { supabase.removeChannel(ch) }
  }, [loadAll])

  // ── Save field — saves directly on patients table by cama ─────────────────
  const handleSaveField = useCallback(async (cama, field, value) => {
    setPatients(prev => prev.map(p =>
      String(p.cama) === String(cama) ? { ...p, [field]: value } : p
    ))
    const { error: err } = await supabase
      .from('patients')
      .update({ [field]: value })
      .eq('cama', cama)
    if (err) console.error('[handleSaveField]', err.message)
  }, [])

  // ── Weekend mode toggle ────────────────────────────────────────────────────
  const toggleWeekend = useCallback(() => {
    setWeekendMode(prev => {
      const next = !prev
      localStorage.setItem('pl_weekend_mode', next ? '1' : '0')
      return next
    })
  }, [])

  // ── patientsMap keyed by cama ──────────────────────────────────────────────
  const patientsMap = {}
  patients.forEach(p => { patientsMap[String(p.cama)] = p })

  // ── Display list: ward beds always shown + extras outside ward ─────────────
  const wardRows = WARD_BEDS
    .map(bed => patientsMap[bed] ?? { cama: bed, _empty: true })

  const extraPatients = patients.filter(p => !WARD_BEDS.includes(String(p.cama)))

  const combined = [...wardRows, ...extraPatients]

  const displayList = combined.filter(pt => {
    if (!search) return true
    const q = search.toLowerCase()
    if (pt._empty) return pt.cama.toLowerCase().includes(q)
    return (
      (pt.nombre ?? '').toLowerCase().includes(q) ||
      String(pt.cama ?? '').toLowerCase().includes(q) ||
      String(pt.exp  ?? '').toLowerCase().includes(q) ||
      (pt.esp  ?? '').toLowerCase().includes(q) ||
      (pt.dx   ?? '').toLowerCase().includes(q)
    )
  })

  const occupiedPatients = patients.filter(p => !p._empty)

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen bg-[#050505] text-[#F4F4F5]">
      {showLabPdf && (
        <LabPdfModal
          currentPatients={patients}
          onClose={() => setShowLabPdf(false)}
          onImported={() => { setShowLabPdf(false); loadAll() }}
        />
      )}

      {showImport && (
        <ImportModal
          currentPatients={patients}
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); loadAll() }}
        />
      )}

      <Sidebar
        patients={occupiedPatients}
        isWeekendMode={isWeekendMode}
        onToggleWeekend={toggleWeekend}
        onSync={loadAll}
        syncStatus={syncStatus}
        search={search}
        onSearch={setSearch}
        onImport={() => setShowImport(true)}
        onImportLabs={() => setShowLabPdf(true)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <MobileHeader
          syncStatus={syncStatus}
          onSync={loadAll}
          search={search}
          onSearch={setSearch}
          onImport={() => setShowImport(true)}
        />

        <BedNavigator patients={occupiedPatients} />

        <main className="flex-1 px-3 py-3 max-w-4xl mx-auto w-full">
          {loading && (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3 text-[#6B7280] font-mono text-xs">
              <span className="text-2xl text-[#D4A373] animate-spin">↻</span>
              <span>Cargando censo…</span>
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
              <span className="text-red-500 font-mono text-xs">{error}</span>
              <button onClick={loadAll}
                      className="text-xs font-mono border border-[#1f1f22] rounded px-4 py-1.5 text-[#6B7280] hover:border-[#6B7280]">
                Reintentar
              </button>
            </div>
          )}

          {!loading && !error && (
            <div className="flex flex-col gap-2">
              {displayList.map(pt => {
              // Merge winlab data: prefer patients.labs_history (DB) over winlab_labs bridge
              const merged = pt._empty ? pt : {
                ...pt,
                labs_history: (pt.labs_history?.length > 0)
                  ? pt.labs_history
                  : (winlab[String(pt.exp ?? '').trim()] ?? []),
              }
              return (
                <PatientCard
                  key={pt.cama}
                  patient={merged}
                  isWeekendMode={isWeekendMode}
                  onSave={(field, value) => handleSaveField(pt.cama, field, value)}
                />
              )
            })}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
