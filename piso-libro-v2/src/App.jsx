import { useState, useEffect, useCallback } from 'react'
import { supabase } from './config/supabase'
import { Header } from './components/Header'
import { PatientCard } from './components/PatientCard'
import './App.css'

// ─── Supabase column list for notes ─────────────────────────────────────────
const NOTES_COLS = [
  'patient_id', 'app', 'pa', 'drenajes', 'qx', 'manejo',
  'sangrado', 'sv', 'balance', 'pendientes', 'misc',
  'checklist', 'lab_history', 'imagen_history', 'updated_by',
].join(',')

// ─── Main App — no auth, zero friction ───────────────────────────────────────
export default function App() {
  const [patients,   setPatients]   = useState([])
  const [notes,      setNotes]      = useState({})    // patient UUID → note row
  const [winlab,     setWinlab]     = useState({})    // exp string  → winlab row
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [syncStatus, setSyncStatus] = useState('idle')
  const [search,     setSearch]     = useState('')

  // ── Initial load ────────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setSyncStatus('syncing')
    try {
      // 1. Patients ordered by bed
      const { data: pts, error: pErr } = await supabase
        .from('patients')
        .select('*')
        .order('cama')
      if (pErr) throw pErr
      setPatients(pts ?? [])

      // 2. Notes — only fetch for patients we just loaded
      if (pts?.length) {
        const ids = pts.map((p) => p.id)
        const { data: nts, error: nErr } = await supabase
          .from('notes')
          .select(NOTES_COLS)
          .in('patient_id', ids)
        if (nErr) throw nErr
        const nMap = {}
        ;(nts ?? []).forEach((n) => { nMap[n.patient_id] = n })
        setNotes(nMap)
      }

      // 3. Winlab — most-recent record per expediente
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

  // ── Realtime listeners ───────────────────────────────────────────────────────
  useEffect(() => {
    loadAll()

    const channel = supabase
      .channel('census-realtime-v2')
      // patients table
      .on('postgres_changes', { event: '*', schema: 'public', table: 'patients' }, (payload) => {
        if (payload.eventType === 'DELETE') {
          setPatients((prev) => prev.filter((p) => p.id !== payload.old.id))
          return
        }
        const row = payload.new
        setPatients((prev) => {
          const idx = prev.findIndex((p) => p.id === row.id)
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = row
            return next
          }
          return [...prev, row].sort((a, b) =>
            String(a.cama).localeCompare(String(b.cama), 'es', { numeric: true }),
          )
        })
      })
      // notes table
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, (payload) => {
        if (payload.eventType === 'DELETE') {
          setNotes((prev) => {
            const next = { ...prev }
            delete next[payload.old.patient_id]
            return next
          })
          return
        }
        const row = payload.new
        setNotes((prev) => ({ ...prev, [row.patient_id]: row }))
      })
      // winlab_labs table — new scrapes arrive via INSERT
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'winlab_labs' }, (payload) => {
        const row = payload.new
        setWinlab((prev) => {
          const existing = prev[row.exp]
          if (existing && existing.scraped_at >= row.scraped_at) return prev
          return { ...prev, [row.exp]: row }
        })
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [loadAll])

  // ── Field save — called by PatientCard on every onBlur ───────────────────────
  // field:  any top-level notes column  OR  'ck_<key>' for checklist subfields
  const handleSave = useCallback(async (patient, field, value) => {
    if (!patient?.id) return

    const existing = notes[patient.id] ?? {}
    let partial

    if (field.startsWith('ck_')) {
      // Merge into checklist JSONB — PostgREST will handle the JSON merge
      const ckKey = field.slice(3)
      partial = {
        patient_id:  patient.id,
        checklist:   { ...(existing.checklist ?? {}), [ckKey]: value },
        updated_by:  localStorage.getItem('pl_user_name') ?? '',
      }
    } else {
      partial = {
        patient_id: patient.id,
        [field]:    value,
        updated_by: localStorage.getItem('pl_user_name') ?? '',
      }
    }

    const { data, error: saveErr } = await supabase
      .from('notes')
      .upsert(partial, { onConflict: 'patient_id' })
      .select()

    if (!saveErr && data?.[0]) {
      // Optimistic update — merge returned row so UI stays in sync
      setNotes((prev) => ({
        ...prev,
        [patient.id]: { ...existing, ...data[0] },
      }))
    } else if (saveErr) {
      console.error('[App] handleSave error:', saveErr.message)
    }
  }, [notes])

  // ── Search filter ────────────────────────────────────────────────────────────
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

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">
      <Header
        syncStatus={syncStatus}
        onSync={loadAll}
        patientCount={patients.length}
        onSearch={setSearch}
        searchQuery={search}
      />

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
            <span>{search ? 'Sin resultados para esa búsqueda' : 'Censo vacío — importa el Excel'}</span>
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="census-list" data-testid="census-list">
            {filtered.map((p) => (
              <PatientCard
                key={`${p.exp}-${p.cama}`}
                patient={p}
                note={notes[p.id]}
                labEntry={winlab[String(p.exp ?? '')]}
                onSave={(field, value) => handleSave(p, field, value)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
