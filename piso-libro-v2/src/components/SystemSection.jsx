// Displays a labeled clinical system/field row with inline edit support

import { useState, useRef } from 'react'

function EditableField({ label, value, field, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const taRef = useRef(null)

  function startEdit() {
    setDraft(value ?? '')
    setEditing(true)
    setTimeout(() => taRef.current?.focus(), 0)
  }

  function commit() {
    setEditing(false)
    if (draft !== (value ?? '')) onSave?.(field, draft)
  }

  function handleKey(e) {
    if (e.key === 'Escape') { setEditing(false); setDraft(value ?? '') }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span style={{
          fontSize: '0.65rem',
          fontFamily: 'JetBrains Mono, monospace',
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
          userSelect: 'none',
        }}>
          {label}
        </span>
        <button
          data-testid={`edit-btn-${field}`}
          onClick={editing ? commit : startEdit}
          title={editing ? 'Guardar' : 'Editar'}
          style={{
            width: '22px', height: '22px',
            borderRadius: '50%',
            background: editing ? 'var(--accent-brand-muted)' : 'var(--bg-surface)',
            border: `1px solid ${editing ? 'var(--accent-primary)' : 'var(--border-default)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            color: editing ? 'var(--accent-primary)' : 'var(--text-muted)',
            transition: 'all 0.2s',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent-primary)'
            e.currentTarget.style.color = 'var(--accent-primary)'
          }}
          onMouseLeave={(e) => {
            if (!editing) {
              e.currentTarget.style.borderColor = 'var(--border-default)'
              e.currentTarget.style.color = 'var(--text-muted)'
            }
          }}
        >
          <i className={`ph ph-${editing ? 'check' : 'pencil-simple'}`} style={{ fontSize: '0.7rem' }} />
        </button>
      </div>

      {editing ? (
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKey}
          rows={3}
          style={{
            width: '100%',
            background: 'var(--bg-surface)',
            border: '1px solid var(--accent-primary)',
            borderRadius: '4px',
            padding: '0.4rem 0.5rem',
            color: 'var(--text-primary)',
            fontFamily: 'Satoshi, sans-serif',
            fontSize: '0.85rem',
            lineHeight: '1.5',
            resize: 'vertical',
            outline: 'none',
          }}
        />
      ) : (
        <p
          onClick={startEdit}
          style={{
            margin: 0,
            color: value ? 'var(--text-primary)' : 'var(--text-muted)',
            fontFamily: 'Satoshi, sans-serif',
            fontSize: '0.875rem',
            lineHeight: '1.6',
            whiteSpace: 'pre-wrap',
            cursor: 'text',
            minHeight: '1.2em',
          }}
        >
          {value || <em style={{ fontStyle: 'normal', color: 'var(--text-muted)' }}>Sin datos</em>}
        </p>
      )}
    </div>
  )
}

const CLINICAL_FIELDS = [
  { field: 'sv',         label: 'SV' },
  { field: 'pa',         label: 'PA' },
  { field: 'balance',    label: 'Balance' },
  { field: 'sangrado',   label: 'Sangrado' },
  { field: 'drenajes',   label: 'Drenajes' },
  { field: 'manejo',     label: 'Manejo' },
  { field: 'qx',         label: 'QX / Procedimiento' },
  { field: 'app',        label: 'APP' },
  { field: 'pendientes', label: 'Pendientes' },
  { field: 'misc',       label: 'Misc' },
]

export function SystemSection({ note, onFieldSave }) {
  return (
    <div
      data-testid="system-section"
      style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
    >
      {CLINICAL_FIELDS.map(({ field, label }) => (
        <EditableField
          key={field}
          field={field}
          label={label}
          value={note?.[field] ?? ''}
          onSave={onFieldSave}
        />
      ))}
    </div>
  )
}
