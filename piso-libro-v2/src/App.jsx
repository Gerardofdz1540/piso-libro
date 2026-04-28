import { useState, useEffect, useCallback } from 'react'
import { supabase } from './config/supabase'
import { Header } from './components/Header'
import { PatientCard } from './components/PatientCard'
import './App.css'

// ─── Supabase columns ────────────────────────────────────────────────────────
const NOTES_COLS = [
  'patient_id', 'app', 'pa', 'drenajes', 'qx', 'manejo',
  'sangrado', 'sv', 'balance', 'pendientes', 'misc',
  'checklist', 'lab_history', 'imagen_history', 'updated_by',
].join(',')

// ─── Specialty colours (for bed-navigator pills) ──────────────────────────────
const ESP_COLOR = {
  CG: '#D4A373', CCR: '#a78bfa', CV: '#60a5fa', CT: '#34d399',
  CPR: '#f472b6', URO: '#fbbf24', NCX: '#f87171',
}

// ─── Bed Navigator ────────────────────────────────────────────────────────────
function BedNavigator({ patients }) {
  function scrollToBed(cama) {
    const el = document.getElementById(`bed-${String(cama).replace(/\s/g, '-')}`)
    if (!el) return
    const offset = 106 // 56px header + 50px navigator
    const y = el.getBoundingClientRect().top + window.scrollY - offset
    window.scrollTo({ top: y, behavior: 'smooth' })
  }

  if (!patients.length) return null

  return (
    <nav className="bed-navigator" aria-label="Navegador de camas">
      <div className="bed-navigator__inner">
        {patients.map((p) => {
          const color = ESP_COLOR[p.esp] ?? '#71717A'
          return (
            <button
              key={p.id}
              onClick={() => scrollToBed(p.cama)}
              title={`${p.nombre} — ${p.dx ?? ''}`}
              style={{
                background: 'transparent',
                border: `1px solid ${color}45`,
                borderRadius: '20px',
                padding: '0.18rem 0.6rem',
                color,
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.72rem',
                fontWeight: 500,
                letterSpacing: '0.04em',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                transition: 'background 0.15s, border-color 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = color + '18'
                e.currentTarget.style.borderColor = color + '90'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.borderColor = color + '45'
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

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [patients,   setPatients]   = useState([])
  const [notes,      setNotes]      = useState({})   // patient UUID → note row
  const [winlab,     setWinlab]     = useState({})   // exp           → winlab row
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [syncStatus, setSyncStatus] = useState('idle')
  const [search,     setSearch]     = useState('')

  // ── Load everything ──────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setSyncStatus('syncing')
    try {
      const { data: pts, error: pErr } = await supabase
        .from('patients').select('*').order('cama')
      if (pErr) throw pErr
      setPatients(pts ?? [])

      if (pts?.length) {
        const ids = pts.map((p) => p.id)
        const { data: nts, error: nErr } = await supabase
          .from('notes').select(NOTES_COLS).in('patient_id', ids)
        if (nErr) throw nErr
        const nMap = {}
        ;(nts ?? []).forEach((n) => { nMap[n.patient_id] = n })
        setNotes(nMap)
      }

      const { data: wl } = await supabase
        .from('winlab_labs')
        .select('exp,fecha,scraped_at,data')
        .order('scraped_at', { ascending: false })
        .limit(500)
      const wMap = {}
      ;(wl ?? []).forEach((r) => {
        if (!wMap[r.exp] || r.scraped_at > wMap[r.exp].scraped_at) wMap[r.exp] = r
      })
      setWinlab(wMap)

      setSyncStatus('ok')
      setError(null)
    } catch (e) {
      setSyncStatus('error')
      setError(e.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Realtime channel (3 tables) ───────────────────────────────────────────────
  useEffect(() => {
    loadAll()

    const ch = supabase
      .channel('census-v3')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'patients' }, (p) => {
        if (p.eventType === 'DELETE') {
          setPatients((prev) => prev.filter((r) => r.id !== p.old.id))
          return
        }
        const row = p.new
        setPatients((prev) => {
          const i = prev.findIndex((r) => r.id === row.id)
          if (i >= 0) { const n = [...prev]; n[i] = row; return n }
          return [...prev, row].sort((a, b) =>
            String(a.cama).localeCompare(String(b.cama), 'es', { numeric: true }))
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, (p) => {
        if (p.eventType === 'DELETE') {
          setNotes((prev) => { const n = { ...prev }; delete n[p.old.patient_id]; return n })
          return
        }
        const row = p.new
        setNotes((prev) => ({ ...prev, [row.patient_id]: row }))
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'winlab_labs' }, (p) => {
        const row = p.new
        setWinlab((prev) => {
          const ex = prev[row.exp]
          if (ex && ex.scraped_at >= row.scraped_at) return prev
          return { ...prev, [row.exp]: row }
        })
      })
      .subscribe()

    return () => { supabase.removeChannel(ch) }
  }, [loadAll])

  // ── Save handler ─────────────────────────────────────────────────────────────
  // field = notes column  OR  'ck_<key>' for checklist JSON subfields
  const handleSave = useCallback(async (patient, field, value) => {
    if (!patient?.id) return
    const existing = notes[patient.id] ?? {}

    const partial = field.startsWith('ck_')
      ? {
          patient_id: patient.id,
          checklist: { ...(existing.checklist ?? {}), [field.slice(3)]: value },
          updated_by: localStorage.getItem('pl_user_name') ?? '',
        }
      : {
          patient_id: patient.id,
          [field]: value,
          updated_by: localStorage.getItem('pl_user_name') ?? '',
        }

    const { data, error: saveErr } = await supabase
      .from('notes')
      .upsert(partial, { onConflict: 'patient_id' })
      .select()

    if (!saveErr && data?.[0]) {
      setNotes((prev) => ({ ...prev, [patient.id]: { ...existing, ...data[0] } }))
    } else if (saveErr) {
      console.error('[handleSave]', saveErr.message)
    }
  }, [notes])

  // ── Search ────────────────────────────────────────────────────────────────────
  const filtered = patients.filter((p) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      p.nombre?.toLowerCase().includes(q) ||
      String(p.cama  ?? '').toLowerCase().includes(q) ||
      String(p.exp   ?? '').toLowerCase().includes(q) ||
      p.esp?.toLowerCase().includes(q) ||
      p.dx?.toLowerCase().includes(q)
    )
  })

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">
      <Header
        syncStatus={syncStatus}
        onSync={loadAll}
        patientCount={patients.length}
        onSearch={setSearch}
        searchQuery={search}
      />

      <BedNavigator patients={filtered} />

      <main className="app-main">
        {loading && (
          <div className="state-center" data-testid="loading-state">
            <i className="ph ph-circle-notch spin"
               style={{ fontSize: '2rem', color: 'var(--accent-primary)' }} />
            <span>Cargando censo…</span>
          </div>
        )}

        {!loading && error && (
          <div className="state-center" data-testid="error-state">
            <i className="ph ph-warning-circle"
               style={{ fontSize: '2rem', color: 'var(--critical-red)' }} />
            <span style={{ color: 'var(--critical-red)' }}>{error}</span>
            <button
              onClick={loadAll}
              style={{
                background: 'none', border: '1px solid var(--border-default)',
                borderRadius: '4px', padding: '0.4rem 1rem',
                color: 'var(--text-secondary)', cursor: 'pointer',
                fontFamily: 'Satoshi, sans-serif',
              }}
            >
              Reintentar
            </button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="state-center" data-testid="empty-state">
            <i className="ph ph-clipboard-text" style={{ fontSize: '2rem' }} />
            <span>{search ? 'Sin resultados' : 'Censo vacío — importa el Excel'}</span>
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="census-list" data-testid="census-list">
            {filtered.map((p) => {
              const labEntry  = winlab[String(p.exp ?? '')]
              const labHistory = labEntry?.data?.reportes ?? []
              return (
                <PatientCard
                  key={`${p.exp}-${p.cama}`}
                  patient={p}
                  note={notes[p.id]}
                  labHistory={labHistory}
                  onSave={(field, value) => handleSave(p, field, value)}
                />
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
