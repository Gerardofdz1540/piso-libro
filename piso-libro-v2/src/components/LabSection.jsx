/**
 * Winlab Pro — delta-aware lab results grid.
 * Compares reportes[0] (latest) vs reportes[1] (previous) when available.
 */

// Which direction is "better" for each analyte
const DIRECTION = {
  HB: 1, HTO: 1, PLT: 1,          // higher = better
  LEUCO: -1, LINFO: 0,             // lower = better, neutral
  CR: -1, BUN: -1,                 // lower = better
  TGO: -1, TGP: -1, FA: -1,        // liver enzymes: lower = better
  BT: -1, BD: -1, BI: -1,          // bilirubin: lower = better
  AMILASA: -1, LIPASA: -1,         // pancreatic: lower = better
  NA: 0, K: 0, CL: 0, CA: 0, MG: 0, // electrolytes: neutral (both extremes bad)
  GLUC: 0, PCR: -1, PROC: -1,
}

const CRITICAL_LOW = { HB: 7, HTO: 21, PLT: 50, NA: 130, K: 3.0, CR: 0 }
const CRITICAL_HIGH = { HB: 18, PLT: 1000, NA: 150, K: 5.5, CR: 5, LEUCO: 15 }

function isCritical(key, val) {
  const k = key.toUpperCase()
  const v = parseFloat(val)
  if (isNaN(v)) return false
  if (CRITICAL_LOW[k] !== undefined && v < CRITICAL_LOW[k]) return true
  if (CRITICAL_HIGH[k] !== undefined && v > CRITICAL_HIGH[k]) return true
  return false
}

function deltaColor(key, newVal, oldVal) {
  const k = key.toUpperCase()
  const n = parseFloat(newVal)
  const o = parseFloat(oldVal)
  if (isNaN(n) || isNaN(o) || n === o) return null
  const dir = DIRECTION[k] ?? 0
  if (dir === 0) return 'var(--warning-amber)' // neutral analyte changed
  const improved = (dir === 1 && n > o) || (dir === -1 && n < o)
  return improved ? 'var(--stable-green)' : 'var(--critical-red)'
}

function DeltaArrow({ newVal, oldVal, analyte }) {
  const n = parseFloat(newVal)
  const o = parseFloat(oldVal)
  if (isNaN(n) || isNaN(o) || n === o) return null
  const up = n > o
  const color = deltaColor(analyte, newVal, oldVal)
  return (
    <span style={{
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '0.7rem',
      color,
      marginLeft: '0.2rem',
    }}>
      {up ? '↑' : '↓'}
    </span>
  )
}

function LabCell({ analyte, current, previous }) {
  const critical = isCritical(analyte, current)
  const hasChange = previous !== undefined && current !== previous

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '0.1rem',
      padding: '0.45rem 0.5rem',
      background: critical ? 'rgba(255,69,58,0.08)' : 'var(--bg-base)',
      border: `1px solid ${critical ? 'rgba(255,69,58,0.3)' : 'var(--border-grid)'}`,
      borderRadius: '4px',
    }}>
      {/* Analyte label */}
      <span style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: '0.6rem',
        letterSpacing: '0.15em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
      }}>
        {analyte}
      </span>

      {/* Current value + delta arrow */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
        <span style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.9rem',
          fontWeight: 600,
          color: critical
            ? 'var(--critical-red)'
            : hasChange
              ? deltaColor(analyte, current, previous)
              : 'var(--accent-primary)',
        }}>
          {current ?? '—'}
        </span>
        {hasChange && (
          <DeltaArrow analyte={analyte} newVal={current} oldVal={previous} />
        )}
      </div>

      {/* Previous value */}
      {hasChange && (
        <span style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.65rem',
          color: 'var(--text-muted)',
          textDecoration: 'line-through',
        }}>
          {previous}
        </span>
      )}
    </div>
  )
}

const SKIP_FIELDS = new Set(['nombre', 'fecha', 'paciente', 'exp', 'cama', 'medico'])

export function LabSection({ labEntry }) {
  if (!labEntry) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        color: 'var(--text-muted)',
        fontFamily: 'Satoshi, sans-serif',
        fontSize: '0.82rem',
        padding: '1rem 0',
      }}>
        <i className="ph ph-flask" />
        <span>Sin labs en Winlab</span>
      </div>
    )
  }

  const reportes = labEntry.data?.reportes ?? []
  const latest = reportes[0] ?? {}
  const prev = reportes[1] ?? {}

  const analytes = Object.keys(latest).filter(
    (k) => !SKIP_FIELDS.has(k.toLowerCase()),
  )

  const scrapedLabel = labEntry.scraped_at
    ? new Date(labEntry.scraped_at).toLocaleDateString('es-MX', {
        day: '2-digit',
        month: 'short',
        year: '2-digit',
      })
    : labEntry.fecha ?? '—'

  const hasDelta = reportes.length >= 2

  return (
    <div data-testid="lab-section" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <i className="ph ph-flask" style={{ color: 'var(--accent-primary)', fontSize: '0.85rem' }} />
          <span style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.65rem',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
          }}>
            Winlab · {scrapedLabel}
          </span>
        </div>
        {hasDelta && (
          <span style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.6rem',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--stable-green)',
            background: 'rgba(50,215,75,0.1)',
            border: '1px solid rgba(50,215,75,0.25)',
            borderRadius: '3px',
            padding: '0.1rem 0.4rem',
          }}>
            Δ Evolución
          </span>
        )}
      </div>

      {analytes.length === 0 ? (
        <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sin valores registrados</span>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
          gap: '0.4rem',
        }}>
          {analytes.map((k) => (
            <LabCell
              key={k}
              analyte={k.toUpperCase()}
              current={latest[k]}
              previous={hasDelta ? prev[k] : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}
