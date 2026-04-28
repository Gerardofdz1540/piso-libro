import { useState, useCallback } from 'react'
import './App.css'
import { Header } from './components/Header'
import { PatientCard } from './components/PatientCard'
import { usePatients } from './hooks/usePatients'
import { useNotes } from './hooks/useNotes'
import { useWinlab } from './hooks/useWinlab'

function matchesSearch(patient, note, q) {
  if (!q) return true
  const lq = q.toLowerCase()
  return (
    patient.nombre?.toLowerCase().includes(lq) ||
    patient.cama?.toLowerCase().includes(lq) ||
    patient.exp?.toLowerCase().includes(lq) ||
    patient.esp?.toLowerCase().includes(lq) ||
    patient.dx?.toLowerCase().includes(lq) ||
    note?.manejo?.toLowerCase().includes(lq) ||
    note?.pendientes?.toLowerCase().includes(lq)
  )
}

export default function App() {
  const { patients, notes, loading, error, syncStatus, reload, upsertPatient, deletePatient } =
    usePatients()
  const { saveNote } = useNotes()
  const { getLabForExp } = useWinlab()

  const [searchQuery, setSearchQuery] = useState('')

  const handleFieldSave = useCallback(
    async (patient, field, value) => {
      if (!patient?.id) return
      const existingNote = notes[patient.id] ?? {}

      let updatedNote
      if (field.startsWith('ck_')) {
        // Checklist subfield: merge into checklist JSON
        const ckKey = field.slice(3)
        updatedNote = {
          ...existingNote,
          checklist: { ...(existingNote.checklist ?? {}), [ckKey]: value },
        }
      } else {
        updatedNote = { ...existingNote, [field]: value }
      }

      await saveNote(patient.id, updatedNote, new Set([field]))
    },
    [notes, saveNote],
  )

  const handleDelete = useCallback(
    async (patient) => {
      if (!window.confirm(`¿Archivar a ${patient.nombre}?`)) return
      await deletePatient(patient.id)
    },
    [deletePatient],
  )

  const filtered = patients.filter((p) => matchesSearch(p, notes[p.id], searchQuery))

  return (
    <div className="app-shell">
      <Header
        syncStatus={syncStatus}
        onSync={reload}
        patientCount={patients.length}
        onSearch={setSearchQuery}
        searchQuery={searchQuery}
      />

      <main className="app-main">
        {loading && (
          <div className="state-center" data-testid="loading-state">
            <i className="ph ph-circle-notch spin" style={{ fontSize: '2rem', color: 'var(--accent-primary)' }} />
            <span>Cargando censo…</span>
          </div>
        )}

        {!loading && error && (
          <div className="state-center" data-testid="error-state">
            <i className="ph ph-warning-circle" style={{ fontSize: '2rem', color: 'var(--critical-red)' }} />
            <span style={{ color: 'var(--critical-red)' }}>{error}</span>
            <button
              onClick={reload}
              style={{
                background: 'none',
                border: '1px solid var(--border-default)',
                borderRadius: '4px',
                padding: '0.4rem 1rem',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                fontFamily: 'var(--font-body)',
              }}
            >
              Reintentar
            </button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="state-center" data-testid="empty-state">
            <i className="ph ph-clipboard-text" style={{ fontSize: '2rem' }} />
            <span>{searchQuery ? 'Sin resultados' : 'Censo vacío — importa el Excel'}</span>
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="census-list" data-testid="census-list">
            {filtered.map((p) => (
              <PatientCard
                key={`${p.exp}-${p.cama}`}
                patient={p}
                note={notes[p.id]}
                labEntry={getLabForExp(p.exp)}
                onFieldSave={handleFieldSave}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
