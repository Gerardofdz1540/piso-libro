import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, TABLES } from '../config/supabase'

export function pid(p) {
  return `pt-${p.exp}-${p.cama}`
}

const NOTES_SELECT =
  'patient_id,app,pa,drenajes,qx,manejo,sangrado,sv,balance,pendientes,misc,checklist,lab_history,imagen_history'

export function usePatients() {
  const [patients, setPatients] = useState([])
  const [notes, setNotes] = useState({}) // keyed by patient_id (uuid)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [syncStatus, setSyncStatus] = useState('idle') // 'idle' | 'syncing' | 'ok' | 'error'
  const channelRef = useRef(null)

  const loadAll = useCallback(async () => {
    setSyncStatus('syncing')
    try {
      const { data: pts, error: ptsErr } = await supabase
        .from(TABLES.PATIENTS)
        .select('*')
        .order('cama')
      if (ptsErr) throw ptsErr

      setPatients(pts ?? [])

      if (pts && pts.length > 0) {
        const ids = pts.map((p) => p.id)
        const { data: nts, error: ntsErr } = await supabase
          .from(TABLES.NOTES)
          .select(NOTES_SELECT)
          .in('patient_id', ids)
        if (ntsErr) throw ntsErr

        const noteMap = {}
        ;(nts ?? []).forEach((n) => {
          noteMap[n.patient_id] = n
        })
        setNotes(noteMap)
      }

      setSyncStatus('ok')
      setError(null)
    } catch (e) {
      setSyncStatus('error')
      setError(e.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // Upsert a patient row; returns the saved patient or null on failure
  const upsertPatient = useCallback(async (patientData) => {
    const { data, error: e } = await supabase
      .from(TABLES.PATIENTS)
      .upsert(patientData, { onConflict: 'exp,cama' })
      .select()
    if (e) { console.error('upsertPatient:', e); return null }
    const saved = data?.[0] ?? null
    if (saved) {
      setPatients((prev) => {
        const idx = prev.findIndex((p) => p.id === saved.id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = saved
          return next
        }
        return [...prev, saved].sort((a, b) => String(a.cama).localeCompare(String(b.cama)))
      })
    }
    return saved
  }, [])

  const deletePatient = useCallback(async (supaId) => {
    const { error: e } = await supabase
      .from(TABLES.PATIENTS)
      .delete()
      .eq('id', supaId)
    if (e) { console.error('deletePatient:', e); return false }
    setPatients((prev) => prev.filter((p) => p.id !== supaId))
    setNotes((prev) => {
      const next = { ...prev }
      delete next[supaId]
      return next
    })
    return true
  }, [])

  // Subscribe to Realtime changes
  useEffect(() => {
    loadAll()

    const channel = supabase
      .channel('piso-libro-v2')
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLES.PATIENTS }, (payload) => {
        if (payload.eventType === 'DELETE') {
          setPatients((prev) => prev.filter((p) => p.id !== payload.old.id))
        } else {
          const row = payload.new
          setPatients((prev) => {
            const idx = prev.findIndex((p) => p.id === row.id)
            if (idx >= 0) {
              const next = [...prev]; next[idx] = row; return next
            }
            return [...prev, row].sort((a, b) => String(a.cama).localeCompare(String(b.cama)))
          })
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLES.NOTES }, (payload) => {
        if (payload.eventType === 'DELETE') {
          setNotes((prev) => {
            const next = { ...prev }
            delete next[payload.old.patient_id]
            return next
          })
        } else {
          const row = payload.new
          setNotes((prev) => ({ ...prev, [row.patient_id]: row }))
        }
      })
      .subscribe()

    channelRef.current = channel
    return () => { supabase.removeChannel(channel) }
  }, [loadAll])

  return {
    patients,
    notes,
    loading,
    error,
    syncStatus,
    reload: loadAll,
    upsertPatient,
    deletePatient,
  }
}
