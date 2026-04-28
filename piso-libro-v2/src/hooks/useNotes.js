import { useCallback, useRef } from 'react'
import { supabase, TABLES } from '../config/supabase'

const FIELD_TO_COL = {
  app: 'app',
  pa: 'pa',
  drenajes: 'drenajes',
  qx: 'qx',
  manejo: 'manejo',
  sangrado: 'sangrado',
  sv: 'sv',
  balance: 'balance',
  pendientes: 'pendientes',
  misc: 'misc',
  labHistory: 'lab_history',
  imagenHistory: 'imagen_history',
}

// Pending outbox for offline support: { patientId, fields, data }[]
const outbox = []
let flushing = false

async function flushOutbox() {
  if (flushing || outbox.length === 0) return
  flushing = true
  while (outbox.length > 0) {
    const item = outbox[0]
    try {
      await supabase
        .from(TABLES.NOTES)
        .upsert(item.data, { onConflict: 'patient_id' })
      outbox.shift()
    } catch {
      break
    }
  }
  flushing = false
}

export function useNotes() {
  const dirtyRef = useRef(new Set())

  const saveNote = useCallback(async (patientId, noteData, dirtyFields = null) => {
    const updatedBy = localStorage.getItem('pl_user_name') ?? ''

    const fullRow = {
      patient_id: patientId,
      app: noteData.app ?? '',
      pa: noteData.pa ?? '',
      drenajes: noteData.drenajes ?? '',
      qx: noteData.qx ?? '',
      manejo: noteData.manejo ?? '',
      sangrado: noteData.sangrado ?? '',
      sv: noteData.sv ?? '',
      balance: noteData.balance ?? '',
      pendientes: noteData.pendientes ?? '',
      misc: noteData.misc ?? '',
      checklist: noteData.checklist ?? {},
      lab_history: noteData.lab_history ?? [],
      imagen_history: noteData.imagen_history ?? [],
      updated_by: updatedBy,
    }

    let row = fullRow
    if (dirtyFields && dirtyFields.size > 0) {
      const partial = { patient_id: patientId, updated_by: updatedBy }
      let needChecklist = false
      dirtyFields.forEach((f) => {
        if (FIELD_TO_COL[f]) partial[FIELD_TO_COL[f]] = fullRow[FIELD_TO_COL[f]]
        if (f.startsWith('ck_') || f === 'entrega' || f === 'body_diagram_ant' || f === 'body_diagram_post') {
          needChecklist = true
        }
      })
      if (needChecklist) partial.checklist = fullRow.checklist
      row = Object.keys(partial).length > 2 ? partial : fullRow
    }

    try {
      const { data, error } = await supabase
        .from(TABLES.NOTES)
        .upsert(row, { onConflict: 'patient_id' })
        .select()
      if (error) throw error
      dirtyRef.current.clear()
      return data?.[0] ?? true
    } catch (e) {
      // Queue for retry when back online
      outbox.push({ patientId, data: row })
      console.warn('useNotes: queued for outbox:', e.message)
      return null
    }
  }, [])

  const markDirty = useCallback((field) => {
    dirtyRef.current.add(field)
  }, [])

  const retryOutbox = useCallback(() => flushOutbox(), [])

  return { saveNote, markDirty, retryOutbox }
}
