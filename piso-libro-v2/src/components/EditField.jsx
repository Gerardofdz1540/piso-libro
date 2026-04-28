import { useState, useEffect, useRef } from 'react'

/**
 * Auto-saving editable field (textarea or single-line input).
 * Saves on blur only when the value actually changed.
 */
export function EditField({
  label,
  field,
  value,
  onSave,
  rows = 3,
  mono = false,
  accentColor = 'var(--accent-primary)',
  placeholder = 'Sin datos',
  'data-testid': testId,
}) {
  const [draft, setDraft] = useState(value ?? '')
  const taRef = useRef(null)

  // Sync if the upstream value changes (realtime update)
  useEffect(() => { setDraft(value ?? '') }, [value])

  function handleBlur() {
    const trimmed = draft.trim()
    if (trimmed !== (value ?? '').trim()) {
      onSave?.(field, trimmed)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) taRef.current?.blur()
    if (e.key === 'Escape') { setDraft(value ?? ''); taRef.current?.blur() }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      {label && (
        <span style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.62rem',
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
          userSelect: 'none',
        }}>
          {label}
        </span>
      )}
      <textarea
        ref={taRef}
        data-testid={testId ?? `field-${field}`}
        value={draft}
        rows={rows}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        style={{
          width: '100%',
          background: 'var(--bg-base)',
          border: `1px solid var(--border-grid)`,
          borderRadius: '4px',
          padding: '0.5rem 0.6rem',
          color: draft ? 'var(--text-primary)' : 'var(--text-muted)',
          fontFamily: mono ? 'JetBrains Mono, monospace' : 'Satoshi, sans-serif',
          fontSize: mono ? '0.8rem' : '0.875rem',
          lineHeight: '1.6',
          resize: 'none',
          outline: 'none',
          transition: 'border-color 0.15s',
        }}
        onFocus={(e) => (e.target.style.borderColor = accentColor)}
        onBlurCapture={(e) => (e.target.style.borderColor = 'var(--border-grid)')}
      />
    </div>
  )
}
