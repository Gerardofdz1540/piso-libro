import { useState } from 'react'
import { LabSection } from './LabSection'
import { EvolucionTab } from './EvolucionTab'
import { PlanTab } from './PlanTab'
import { EditField } from './EditField'

// ─── Specialty colours ───────────────────────────────────────────────────────
const ESP_COLORS = {
  CG: '#D4A373', CCR: '#a78bfa', CV: '#60a5fa', CT: '#34d399',
  CPR: '#f472b6', URO: '#fbbf24', NCX: '#f87171',
}

function EspBadge({ esp }) {
  const color = ESP_COLORS[esp] ?? 'var(--text-muted)'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '0.15rem 0.5rem', borderRadius: '3px',
      background: color + '20', border: `1px solid ${color}40`,
      color, fontFamily: 'JetBrains Mono, monospace',
      fontSize: '0.62rem', fontWeight: 500,
      letterSpacing: '0.12em', textTransform: 'uppercase',
    }}>
      {esp}
    </span>
  )
}

// ─── Post-op day badge ───────────────────────────────────────────────────────
function PodBadge({ qxDate }) {
  if (!qxDate) return null
  const diff = Math.floor((Date.now() - new Date(qxDate).getTime()) / 86_400_000)
  if (diff < 0 || diff > 365) return null
  const label = diff === 0 ? 'QX HOY' : `POD ${diff}`
  const color = diff <= 1 ? 'var(--critical-red)' : diff <= 3 ? 'var(--warning-amber)' : 'var(--stable-green)'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
      padding: '0.15rem 0.5rem', borderRadius: '3px',
      background: color + '15', border: `1px solid ${color}40`,
      color, fontFamily: 'JetBrains Mono, monospace',
      fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em',
    }}>
      <i className="ph ph-calendar-blank" style={{ fontSize: '0.65rem' }} />
      {label}
    </span>
  )
}

// ─── Hallazgos transoperatorios block ────────────────────────────────────────
function HallazgosBlock({ value, onSave }) {
  if (!value && value !== '') return null
  return (
    <div style={{
      margin: '0 1rem',
      padding: '0.7rem 0.85rem',
      background: 'rgba(212,163,115,0.06)',
      border: '1px solid rgba(212,163,115,0.25)',
      borderRadius: '5px',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.35rem',
        marginBottom: '0.4rem',
      }}>
        <i className="ph ph-eye" style={{ color: 'var(--accent-primary)', fontSize: '0.8rem' }} />
        <span style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem',
          letterSpacing: '0.2em', textTransform: 'uppercase',
          color: 'var(--accent-primary)',
        }}>
          Hallazgos Transoperatorios
        </span>
      </div>
      <EditField
        field="ck_hallazgos_transop"
        value={value}
        onSave={onSave}
        rows={2}
        accentColor="var(--accent-primary)"
        placeholder="Hallazgos intraoperatorios, anatomía patológica..."
      />
    </div>
  )
}

// ─── QX field with date picker ────────────────────────────────────────────────
function QxHeader({ qx, qxDate, onSave }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <EditField
          label="QX · Procedimiento"
          field="qx"
          value={qx}
          onSave={onSave}
          rows={1}
          placeholder="Nombre del procedimiento quirúrgico..."
        />
        <div style={{ flexShrink: 0 }}>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem',
            letterSpacing: '0.15em', textTransform: 'uppercase',
            color: 'var(--text-muted)', display: 'block', marginBottom: '0.3rem',
          }}>
            Fecha QX
          </span>
          <input
            type="date"
            defaultValue={qxDate ?? ''}
            onBlur={(e) => {
              const v = e.target.value
              if (v !== (qxDate ?? '')) onSave?.('ck_qx_date', v || null)
            }}
            style={{
              background: 'var(--bg-base)',
              border: '1px solid var(--border-grid)',
              borderRadius: '4px',
              padding: '0.5rem 0.6rem',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: '0.78rem',
              outline: 'none',
              colorScheme: 'dark',
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Tab button ───────────────────────────────────────────────────────────────
const TABS = [
  { id: 'evolucion', icon: 'activity',       label: 'Evolución' },
  { id: 'plan',      icon: 'clipboard-text', label: 'Plan' },
  { id: 'labs',      icon: 'flask',          label: 'Labs' },
]

function TabBar({ active, onChange }) {
  return (
    <div style={{
      display: 'flex', borderBottom: '1px solid var(--border-grid)',
      padding: '0 1rem', gap: 0,
    }}>
      {TABS.map(({ id, icon, label }) => (
        <button
          key={id}
          data-testid={`tab-${id}`}
          onClick={() => onChange(id)}
          style={{
            background: 'none', border: 'none',
            borderBottom: active === id
              ? '2px solid var(--accent-primary)'
              : '2px solid transparent',
            padding: '0.55rem 0.9rem',
            color: active === id ? 'var(--accent-primary)' : 'var(--text-muted)',
            fontFamily: 'Satoshi, sans-serif', fontSize: '0.8rem', fontWeight: 500,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.35rem',
            transition: 'color 0.15s', marginBottom: '-1px',
          }}
          onMouseEnter={(e) => { if (active !== id) e.currentTarget.style.color = 'var(--text-secondary)' }}
          onMouseLeave={(e) => { if (active !== id) e.currentTarget.style.color = 'var(--text-muted)' }}
        >
          <i className={`ph ph-${icon}`} />
          {label}
        </button>
      ))}
    </div>
  )
}

// ─── PatientCard ──────────────────────────────────────────────────────────────
export function PatientCard({ patient, note, labEntry, onFieldSave, onDelete }) {
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState('evolucion')

  const { nombre, cama, exp, esp, dx } = patient
  const ck = note?.checklist ?? {}

  // Delegate saves: top-level fields use field name, checklist subfields use 'ck_*'
  function handleSave(field, value) {
    onFieldSave?.(patient, field, value)
  }

  return (
    <article
      data-testid={`patient-card-${exp}-${cama}`}
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: '6px',
        overflow: 'hidden',
        transition: 'border-color 0.2s, box-shadow 0.2s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-focus)'
        e.currentTarget.style.boxShadow = '0 0 0 1px rgba(212,163,115,0.1)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-default)'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      {/* ── Collapsed header row ─────────────────────────────────────────────── */}
      <div
        onClick={() => setExpanded((x) => !x)}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          padding: '0.75rem 1rem', cursor: 'pointer', userSelect: 'none',
        }}
      >
        {/* Cama — oversized mono */}
        <span style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '1.35rem', fontWeight: 400,
          color: 'var(--text-muted)',
          minWidth: '64px', letterSpacing: '-0.02em',
        }}>
          {cama}
        </span>

        {/* Name + DX */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <p style={{
            margin: 0,
            fontFamily: 'Cabinet Grotesk, sans-serif',
            fontWeight: 700, fontSize: '1rem',
            color: 'var(--text-primary)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            letterSpacing: '-0.01em',
          }}>
            {nombre}
          </p>
          {dx && (
            <p style={{
              margin: 0,
              fontFamily: 'Satoshi, sans-serif', fontSize: '0.78rem',
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {dx}
            </p>
          )}
        </div>

        {/* Badges */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
          {esp && <EspBadge esp={esp} />}
          <PodBadge qxDate={ck.qx_date} />
        </div>

        {/* Chevron */}
        <i
          className={`ph ph-caret-${expanded ? 'up' : 'down'}`}
          style={{ color: 'var(--text-muted)', fontSize: '0.8rem', flexShrink: 0 }}
        />
      </div>

      {/* ── Expanded body ────────────────────────────────────────────────────── */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border-grid)' }}>
          {/* QX block + hallazgos */}
          <div style={{
            padding: '0.75rem 1rem',
            borderBottom: '1px solid var(--border-grid)',
            display: 'flex', flexDirection: 'column', gap: '0.6rem',
          }}>
            <QxHeader
              qx={note?.qx}
              qxDate={ck.qx_date}
              onSave={handleSave}
            />
          </div>

          {/* Hallazgos transoperatorios */}
          {(ck.hallazgos_transop || ck.hallazgos_transop === '') && (
            <div style={{ paddingTop: '0.6rem', paddingBottom: '0.4rem' }}>
              <HallazgosBlock value={ck.hallazgos_transop} onSave={handleSave} />
            </div>
          )}

          {/* "Agregar hallazgos" trigger if not yet present */}
          {ck.hallazgos_transop === undefined && (
            <div style={{ padding: '0.4rem 1rem' }}>
              <button
                onClick={() => handleSave('ck_hallazgos_transop', '')}
                style={{
                  background: 'none',
                  border: '1px dashed rgba(212,163,115,0.3)',
                  borderRadius: '4px',
                  padding: '0.3rem 0.75rem',
                  color: 'var(--accent-primary)',
                  fontFamily: 'Satoshi, sans-serif',
                  fontSize: '0.78rem',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: '0.35rem',
                  transition: 'all 0.15s',
                  opacity: 0.7,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
              >
                <i className="ph ph-plus" style={{ fontSize: '0.75rem' }} />
                Hallazgos transoperatorios
              </button>
            </div>
          )}

          {/* Tab bar */}
          <TabBar active={tab} onChange={setTab} />

          {/* Tab content */}
          <div style={{ padding: '1rem' }}>
            {tab === 'evolucion' && (
              <EvolucionTab note={note} onSave={handleSave} />
            )}
            {tab === 'plan' && (
              <PlanTab note={note} onSave={handleSave} />
            )}
            {tab === 'labs' && (
              <LabSection labEntry={labEntry} />
            )}
          </div>

          {/* Footer — delete action */}
          <div style={{
            display: 'flex', justifyContent: 'flex-end',
            padding: '0.5rem 1rem',
            borderTop: '1px solid var(--border-grid)',
          }}>
            <button
              data-testid={`delete-patient-${exp}`}
              onClick={(e) => { e.stopPropagation(); onDelete?.(patient) }}
              title="Archivar paciente"
              style={{
                background: 'none', border: 'none',
                padding: '0.3rem 0.6rem',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '0.35rem',
                fontFamily: 'Satoshi, sans-serif', fontSize: '0.75rem',
                transition: 'color 0.15s',
                borderRadius: '4px',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--critical-red)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
            >
              <i className="ph ph-archive" style={{ fontSize: '0.85rem' }} />
              Archivar
            </button>
          </div>
        </div>
      )}
    </article>
  )
}
