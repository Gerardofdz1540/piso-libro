import { useState } from 'react'

export function Header({ syncStatus, onSync, patientCount, onSearch, searchQuery }) {
  const [localQ, setLocalQ] = useState(searchQuery ?? '')

  const syncIcon = {
    idle: 'ph-arrows-clockwise',
    syncing: 'ph-arrows-clockwise ph-spin',
    ok: 'ph-check-circle',
    error: 'ph-warning-circle',
  }[syncStatus] ?? 'ph-arrows-clockwise'

  const syncColor = {
    ok: 'var(--stable-green)',
    error: 'var(--critical-red)',
    syncing: 'var(--accent)',
  }[syncStatus] ?? 'var(--text-secondary)'

  function handleSearch(e) {
    const v = e.target.value
    setLocalQ(v)
    onSearch?.(v)
  }

  return (
    <header data-testid="app-header" style={{
      display: 'flex',
      alignItems: 'center',
      gap: '1rem',
      padding: '0 1.5rem',
      height: '56px',
      background: 'var(--bg-base)',
      borderBottom: '1px solid var(--border-default)',
      position: 'sticky',
      top: 0,
      zIndex: 100,
    }}>
      {/* Logo */}
      <span style={{
        fontFamily: 'Cabinet Grotesk, sans-serif',
        fontWeight: 800,
        fontSize: '1.1rem',
        color: 'var(--accent-primary)',
        letterSpacing: '-0.03em',
        whiteSpace: 'nowrap',
      }}>
        Piso Libro
      </span>

      <span style={{
        fontSize: '0.7rem',
        fontFamily: 'JetBrains Mono, monospace',
        color: 'var(--text-muted)',
        letterSpacing: '0.15em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}>
        {patientCount ?? 0} pac
      </span>

      {/* Search */}
      <div style={{ flex: 1, maxWidth: '400px' }}>
        <div style={{ position: 'relative' }}>
          <i className="ph ph-magnifying-glass" style={{
            position: 'absolute',
            left: '0.6rem',
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--text-muted)',
            fontSize: '0.85rem',
          }} />
          <input
            data-testid="header-search"
            type="search"
            placeholder="Buscar paciente, cama, exp…"
            value={localQ}
            onChange={handleSearch}
            style={{
              width: '100%',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              borderRadius: '4px',
              padding: '0.35rem 0.75rem 0.35rem 2rem',
              color: 'var(--text-primary)',
              fontFamily: 'Satoshi, sans-serif',
              fontSize: '0.85rem',
              outline: 'none',
              transition: 'border-color 0.2s',
            }}
            onFocus={(e) => (e.target.style.borderColor = 'var(--accent-primary)')}
            onBlur={(e) => (e.target.style.borderColor = 'var(--border-default)')}
          />
        </div>
      </div>

      <div style={{ flex: 1 }} />

      {/* Sync status */}
      <button
        data-testid="sync-btn"
        onClick={onSync}
        title={`Sincronizar (${syncStatus})`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          background: 'none',
          border: '1px solid var(--border-default)',
          borderRadius: '4px',
          padding: '0.3rem 0.75rem',
          color: syncColor,
          cursor: 'pointer',
          fontFamily: 'Satoshi, sans-serif',
          fontSize: '0.8rem',
          transition: 'all 0.2s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--accent-primary)'
          e.currentTarget.style.color = 'var(--accent-primary)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--border-default)'
          e.currentTarget.style.color = syncColor
        }}
      >
        <i className={`ph ${syncIcon}`} />
        <span style={{ display: 'none' }} data-sm="show">Sincronizar</span>
      </button>
    </header>
  )
}
