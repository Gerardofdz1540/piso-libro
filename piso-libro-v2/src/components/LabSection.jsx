// Displays winlab lab results for a single patient

const CRITICAL_LOW = { HB: 7, HTO: 21, PLT: 50, NA: 130, K: 3.0, CR: 1.5 }
const CRITICAL_HIGH = { HB: 18, PLT: 1000, NA: 150, K: 5.5, CR: 5, LEUCO: 15 }

function criticalClass(key, value) {
  const k = key.toUpperCase()
  const v = parseFloat(value)
  if (isNaN(v)) return null
  if (CRITICAL_LOW[k] !== undefined && v < CRITICAL_LOW[k]) return 'critical'
  if (CRITICAL_HIGH[k] !== undefined && v > CRITICAL_HIGH[k]) return 'critical'
  return null
}

function LabRow({ label, value }) {
  const cls = criticalClass(label, value)
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '0.2rem 0',
      borderBottom: '1px solid var(--border-grid)',
    }}>
      <span style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: '0.7rem',
        letterSpacing: '0.15em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: '0.85rem',
        fontWeight: 500,
        color: cls === 'critical' ? 'var(--critical-red)' : 'var(--accent-primary)',
      }}>
        {value ?? '—'}
      </span>
    </div>
  )
}

export function LabSection({ labEntry }) {
  if (!labEntry) {
    return (
      <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontFamily: 'Satoshi, sans-serif' }}>
        Sin labs en Winlab
      </div>
    )
  }

  const { fecha, scraped_at, data } = labEntry
  const reportes = data?.reportes ?? []
  const latest = reportes[0] ?? {}
  const rows = Object.entries(latest).filter(([k]) => k !== 'nombre' && k !== 'fecha')

  const scrapedDate = scraped_at
    ? new Date(scraped_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })
    : null

  return (
    <div data-testid="lab-section" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '0.25rem',
      }}>
        <span style={{
          fontSize: '0.65rem',
          fontFamily: 'JetBrains Mono, monospace',
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
        }}>
          Labs · {fecha ?? scrapedDate ?? '—'}
        </span>
        <i className="ph ph-flask" style={{ color: 'var(--accent-primary)', fontSize: '0.8rem' }} />
      </div>

      {rows.length === 0 ? (
        <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sin valores</span>
      ) : (
        rows.map(([k, v]) => <LabRow key={k} label={k} value={v} />)
      )}
    </div>
  )
}
