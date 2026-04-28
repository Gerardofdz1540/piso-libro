import { useState } from 'react'
import { LabSection } from './LabSection'
import { SystemSection } from './SystemSection'

const ESP_COLORS = {
  CG: '#D4A373',
  CCR: '#a78bfa',
  CV: '#60a5fa',
  CT: '#34d399',
  CPR: '#f472b6',
  URO: '#fbbf24',
  NCX: '#f87171',
}

function EspBadge({ esp }) {
  const color = ESP_COLORS[esp] ?? 'var(--text-muted)'
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0.1rem 0.5rem',
      borderRadius: '3px',
      background: color + '20',
      border: `1px solid ${color}40`,
      color,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '0.65rem',
      fontWeight: 500,
      letterSpacing: '0.15em',
      textTransform: 'uppercase',
    }}>
      {esp}
    </span>
  )
}

export function PatientCard({ patient, note, labEntry, onFieldSave, onDelete }) {
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState('sistema') // 'sistema' | 'labs'

  const { nombre, cama, exp, esp, dx, edad, sexo } = patient

  return (
    <article
      data-testid={`patient-card-${exp}-${cama}`}
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: '6px',
        overflow: 'hidden',
        transition: 'border-color 0.2s',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-default)')}
    >
      {/* Card header row */}
      <div
        onClick={() => setExpanded((x) => !x)}
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto auto auto',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.65rem 1rem',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {/* Cama */}
        <span style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          minWidth: '52px',
        }}>
          {cama}
        </span>

        {/* Nombre + DX */}
        <div style={{ overflow: 'hidden' }}>
          <p style={{
            margin: 0,
            fontFamily: 'Cabinet Grotesk, sans-serif',
            fontWeight: 700,
            fontSize: '0.95rem',
            color: 'var(--text-primary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {nombre}
          </p>
          {dx && (
            <p style={{
              margin: 0,
              fontFamily: 'Satoshi, sans-serif',
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {dx}
            </p>
          )}
        </div>

        {/* Esp badge */}
        {esp && <EspBadge esp={esp} />}

        {/* Exp */}
        <span style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          display: 'none',
        }}
          data-sm="show"
        >
          {exp}
        </span>

        {/* Chevron */}
        <i className={`ph ph-caret-${expanded ? 'up' : 'down'}`} style={{
          color: 'var(--text-muted)',
          fontSize: '0.8rem',
          flexShrink: 0,
        }} />
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border-grid)' }}>
          {/* Tabs */}
          <div style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-grid)',
            padding: '0 1rem',
            gap: '0',
          }}>
            {[
              { id: 'sistema', icon: 'ph-stethoscope', label: 'Sistema' },
              { id: 'labs', icon: 'ph-flask', label: 'Labs' },
            ].map(({ id, icon, label }) => (
              <button
                key={id}
                data-testid={`tab-${id}`}
                onClick={() => setTab(id)}
                style={{
                  background: 'none',
                  border: 'none',
                  borderBottom: tab === id ? '2px solid var(--accent-primary)' : '2px solid transparent',
                  padding: '0.5rem 1rem',
                  color: tab === id ? 'var(--accent-primary)' : 'var(--text-muted)',
                  fontFamily: 'Satoshi, sans-serif',
                  fontSize: '0.8rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  transition: 'color 0.2s',
                  marginBottom: '-1px',
                }}
              >
                <i className={`ph ${icon}`} />
                {label}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            {/* Delete action */}
            <button
              data-testid={`delete-patient-${exp}`}
              onClick={(e) => { e.stopPropagation(); onDelete?.(patient) }}
              title="Archivar paciente"
              style={{
                background: 'none',
                border: 'none',
                padding: '0.5rem 0.5rem',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                transition: 'color 0.2s',
                alignSelf: 'center',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--critical-red)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
            >
              <i className="ph ph-archive" style={{ fontSize: '0.9rem' }} />
            </button>
          </div>

          {/* Tab content */}
          <div style={{ padding: '1rem' }}>
            {tab === 'sistema' && (
              <SystemSection note={note} onFieldSave={(field, value) => onFieldSave?.(patient, field, value)} />
            )}
            {tab === 'labs' && (
              <LabSection labEntry={labEntry} />
            )}
          </div>
        </div>
      )}
    </article>
  )
}
