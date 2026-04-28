import { EditField } from './EditField'

const EMERALD = '#34D399'
const EMERALD_DIM = '#34D39918'
const EMERALD_BORDER = '#34D39940'

function PlanBlock({ icon, title, accentColor, children }) {
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: `1px solid ${accentColor}40`,
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
        borderBottom: `1px solid ${accentColor}30`,
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

export function PlanTab({ note, onSave }) {
  const ck = note?.checklist ?? {}

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* Conducta / Plan — prominent, emerald accent */}
      <div style={{
        background: EMERALD_DIM,
        border: `1px solid ${EMERALD_BORDER}`,
        borderRadius: '6px',
        padding: '0.85rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          paddingBottom: '0.4rem',
          borderBottom: `1px solid ${EMERALD_BORDER}`,
        }}>
          <i className="ph ph-clipboard-text" style={{ color: EMERALD, fontSize: '0.95rem' }} />
          <span style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.62rem',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: EMERALD,
          }}>
            Conducta · Plan
          </span>
        </div>
        <EditField
          field="manejo"
          value={note?.manejo}
          onSave={onSave}
          rows={5}
          accentColor={EMERALD}
          placeholder="Conducta médica, plan quirúrgico, manejo..."
        />
      </div>

      {/* Lower 3-column grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '0.75rem',
      }}>
        <PlanBlock icon="hourglass" title="Pendientes" accentColor="var(--warning-amber)">
          <EditField
            field="pendientes"
            value={note?.pendientes}
            onSave={onSave}
            rows={4}
            accentColor="var(--warning-amber)"
            placeholder="Estudios, trámites, evolución..."
          />
        </PlanBlock>

        <PlanBlock icon="chats-circle" title="Interconsultas" accentColor="var(--info-blue)">
          <EditField
            field="ck_interconsultas"
            value={ck.interconsultas}
            onSave={onSave}
            rows={4}
            accentColor="var(--info-blue)"
            placeholder="Cardiología, Nefrología, UCI..."
          />
        </PlanBlock>
      </div>

      {/* Imagen pendiente — full width */}
      <PlanBlock icon="scan" title="Imagen Pendiente" accentColor="var(--text-secondary)">
        <EditField
          field="ck_imagen"
          value={ck.imagen}
          onSave={onSave}
          rows={2}
          placeholder="USG, TC, RX, resonancia..."
        />
      </PlanBlock>

      {/* Misc */}
      <EditField
        label="Notas adicionales"
        field="misc"
        value={note?.misc}
        onSave={onSave}
        rows={2}
        placeholder="Observaciones, notas de guardia..."
      />
    </div>
  )
}
