import { EditField } from './EditField'

/**
 * Reads from existing note columns:
 *   sv          → Ventilatorio
 *   pa          → Hemodinámico
 *   drenajes    → Drenajes / Renal
 *   balance     → Balance Hídrico (texto libre)
 *   sangrado    → Sangrado
 * New fields stored in checklist JSON (prefix ck_):
 *   ck_renal    → Renal (Cr, diuresis, BUN)
 *   ck_bal_i    → Balance Ingresos (mL)
 *   ck_bal_e    → Balance Egresos (mL)
 */

function SystemBlock({ icon, title, accentColor = 'var(--accent-primary)', children }) {
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: `1px solid var(--border-grid)`,
      borderRadius: '6px',
      padding: '0.85rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.6rem',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.4rem',
        paddingBottom: '0.4rem',
        borderBottom: '1px solid var(--border-grid)',
      }}>
        <i className={`ph ph-${icon}`} style={{ color: accentColor, fontSize: '0.9rem' }} />
        <span style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.62rem',
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: accentColor,
        }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  )
}

function BalanceRow({ label, value, field, onSave, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <span style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: '0.68rem',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
        minWidth: '72px',
        flexShrink: 0,
      }}>
        {label}
      </span>
      <input
        type="text"
        defaultValue={value ?? ''}
        placeholder="—"
        onBlur={(e) => {
          const v = e.target.value.trim()
          if (v !== (value ?? '').trim()) onSave?.(field, v)
        }}
        style={{
          flex: 1,
          background: 'var(--bg-base)',
          border: '1px solid var(--border-grid)',
          borderRadius: '3px',
          padding: '0.25rem 0.5rem',
          color: color ?? 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.82rem',
          outline: 'none',
          transition: 'border-color 0.15s',
        }}
        onFocus={(e) => (e.target.style.borderColor = 'var(--accent-primary)')}
        onBlurCapture={(e) => (e.target.style.borderColor = 'var(--border-grid)')}
      />
    </div>
  )
}

function calcNeto(i, e) {
  const vi = parseFloat(String(i ?? '').replace(/[^\d.-]/g, ''))
  const ve = parseFloat(String(e ?? '').replace(/[^\d.-]/g, ''))
  if (isNaN(vi) || isNaN(ve)) return null
  const net = vi - ve
  return { value: net, positive: net >= 0 }
}

export function EvolucionTab({ note, onSave }) {
  const ck = note?.checklist ?? {}

  const neto = calcNeto(ck.bal_i, ck.bal_e)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* 2-column grid for the four systems */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '0.75rem',
      }}>
        {/* Ventilatorio */}
        <SystemBlock icon="lungs" title="Ventilatorio" accentColor="var(--info-blue)">
          <EditField
            field="sv"
            value={note?.sv}
            onSave={onSave}
            rows={3}
            mono
            accentColor="var(--info-blue)"
            placeholder="SatO2, FR, FiO2, modalidad..."
          />
        </SystemBlock>

        {/* Hemodinámico */}
        <SystemBlock icon="heartbeat" title="Hemodinámico" accentColor="var(--critical-red)">
          <EditField
            field="pa"
            value={note?.pa}
            onSave={onSave}
            rows={3}
            mono
            accentColor="var(--critical-red)"
            placeholder="TA, FC, PAM, ritmo..."
          />
        </SystemBlock>

        {/* Renal */}
        <SystemBlock icon="drop" title="Renal" accentColor="var(--warning-amber)">
          <EditField
            field="ck_renal"
            value={ck.renal}
            onSave={onSave}
            rows={3}
            mono
            accentColor="var(--warning-amber)"
            placeholder="Cr, BUN, diuresis (mL/h)..."
          />
        </SystemBlock>

        {/* Balance Hídrico */}
        <SystemBlock icon="waves" title="Balance Hídrico" accentColor="var(--stable-green)">
          <BalanceRow
            label="Ingresos"
            value={ck.bal_i}
            field="ck_bal_i"
            onSave={onSave}
            color="var(--info-blue)"
          />
          <BalanceRow
            label="Egresos"
            value={ck.bal_e}
            field="ck_bal_e"
            onSave={onSave}
            color="var(--warning-amber)"
          />
          {neto !== null && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: '0.3rem',
              borderTop: '1px solid var(--border-grid)',
            }}>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.68rem',
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
              }}>
                Neto
              </span>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.9rem',
                fontWeight: 700,
                color: neto.positive ? 'var(--stable-green)' : 'var(--critical-red)',
              }}>
                {neto.positive ? '+' : ''}{neto.value.toFixed(0)} mL
              </span>
            </div>
          )}
        </SystemBlock>
      </div>

      {/* Sangrado + Drenajes — full width */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '0.75rem',
      }}>
        <EditField
          label="Sangrado"
          field="sangrado"
          value={note?.sangrado}
          onSave={onSave}
          rows={2}
          mono
        />
        <EditField
          label="Drenajes"
          field="drenajes"
          value={note?.drenajes}
          onSave={onSave}
          rows={2}
          mono
        />
      </div>

      {/* APP / Antecedentes */}
      <EditField
        label="APP · Antecedentes"
        field="app"
        value={note?.app}
        onSave={onSave}
        rows={2}
      />
    </div>
  )
}
