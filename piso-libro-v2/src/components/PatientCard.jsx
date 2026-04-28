/**
 * PatientCard — Goodnotes-style surgical census card
 *
 * Props:
 *   patient   { id, cama, nombre, exp, esp, dx, edad, sexo }
 *   note      { sv, pa, drenajes, qx, manejo, sangrado, balance,
 *               pendientes, misc, app, checklist{} }
 *   labEntry  { fecha, scraped_at, data: { reportes: [] } }
 *   onSave    (field: string, value: string) => void
 *             field is a notes column name OR 'ck_<key>' for checklist subfields
 */

import { useState, useEffect, useRef } from 'react'

// ─── Design tokens (mirror App.css) ─────────────────────────────────────────
const C = {
  bgBase:       '#0A0A0B',
  bgSurface:    '#121214',
  bgPanel:      '#171719',
  borderDefault:'#27272A',
  borderGrid:   '#1F1F22',
  borderFocus:  '#D4A373',
  textPrimary:  '#F4F4F5',
  textSecondary:'#A1A1AA',
  textMuted:    '#71717A',
  accent:       '#D4A373',
  accentDim:    '#D4A37318',
  red:          '#FF453A',
  amber:        '#FF9F0A',
  green:        '#32D74B',
  blue:         '#0A84FF',
  emerald:      '#34D399',
  emeraldDim:   '#34D39915',
}

// ─── Specialty palette ────────────────────────────────────────────────────────
const ESP_COLOR = {
  CG:'#D4A373', CCR:'#a78bfa', CV:'#60a5fa', CT:'#34d399',
  CPR:'#f472b6', URO:'#fbbf24', NCX:'#f87171',
}

// ─── Lab analyte config ───────────────────────────────────────────────────────
// direction:  1 = higher-better  -1 = lower-better  0 = neutral (both extremes bad)
const LAB_CONFIG = [
  { key: 'LEU',  label: 'Leu',    unit: '×10³', direction: -1, critLow: 2,   critHigh: 15   },
  { key: 'HB',   label: 'Hb',     unit: 'g/dL', direction:  1, critLow: 7,   critHigh: 18   },
  { key: 'PLAQ', label: 'Plaq',   unit: '×10³', direction:  1, critLow: 50,  critHigh: 1000 },
  { key: 'GLU',  label: 'Glu',    unit: 'mg/dL',direction:  0, critLow: 60,  critHigh: 400  },
  { key: 'UREA', label: 'Urea',   unit: 'mg/dL',direction: -1, critLow: null,critHigh: 60   },
  { key: 'CR',   label: 'Cr',     unit: 'mg/dL',direction: -1, critLow: null,critHigh: 5    },
  { key: 'NA',   label: 'Na',     unit: 'mEq/L',direction:  0, critLow: 130, critHigh: 150  },
  { key: 'K',    label: 'K',      unit: 'mEq/L',direction:  0, critLow: 3.0, critHigh: 5.5  },
  { key: 'CL',   label: 'Cl',     unit: 'mEq/L',direction:  0, critLow: 95,  critHigh: 110  },
  { key: 'LAC',  label: 'Lactato',unit: 'mmol/L',direction:-1, critLow: null,critHigh: 4    },
]

// Aliases: normalize raw winlab key → our canonical key
const ALIAS = {
  LEUCOCITOS:'LEU', LEUCOS:'LEU', LEUCO:'LEU', WBC:'LEU', GB:'LEU',
  HEMOGLOBINA:'HB', HGB:'HB', HGL:'HB',
  PLAQUETAS:'PLAQ', PLT:'PLAQ', TROMBOCITOS:'PLAQ',
  GLUCOSA:'GLU', GLUCOSE:'GLU',
  UREA:'UREA', BUN:'UREA',
  CREATININA:'CR', CREAT:'CR', CREATININE:'CR',
  SODIO:'NA', SODIUM:'NA',
  POTASIO:'K', POTASSIUM:'K',
  CLORO:'CL', CLORURO:'CL', CHLORIDE:'CL',
  LACTATO:'LAC', LACTATE:'LAC', 'ACIDO LACTICO':'LAC', 'ÁCIDO LÁCTICO':'LAC',
  // already canonical
  LEU:'LEU', HB:'HB', PLAQ:'PLAQ', GLU:'GLU', CR:'CR',
  NA:'NA', K:'K', CL:'CL', LAC:'LAC',
}

function normalizeLabKey(raw) {
  const k = String(raw ?? '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .trim()
  return ALIAS[k] ?? null
}

// Flatten a single reporte object → { canonical_key: numeric_value_string }
function flattenReporte(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  Object.entries(obj).forEach(([k, v]) => {
    const canonical = normalizeLabKey(k)
    if (canonical && v !== undefined && v !== null && v !== '') out[canonical] = String(v)
  })
  return out
}

function isCritical(cfg, val) {
  const v = parseFloat(val)
  if (isNaN(v)) return false
  if (cfg.critLow  != null && v < cfg.critLow)  return true
  if (cfg.critHigh != null && v > cfg.critHigh) return true
  return false
}

// Returns CSS color for the delta, or null if no meaningful change
function deltaColor(cfg, current, previous) {
  const cur = parseFloat(current)
  const pre = parseFloat(previous)
  if (isNaN(cur) || isNaN(pre)) return null
  const diff = cur - pre
  if (Math.abs(diff) < 0.001) return null
  if (cfg.direction === 0) return C.amber          // neutral — any change is flagged
  const improved = (cfg.direction === 1 && diff > 0) || (cfg.direction === -1 && diff < 0)
  return improved ? C.green : C.red
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function EspBadge({ esp }) {
  const color = ESP_COLOR[esp] ?? C.textMuted
  return (
    <span style={{
      padding: '0.12rem 0.45rem', borderRadius: '3px',
      background: color + '20', border: `1px solid ${color}35`,
      color, fontFamily: 'JetBrains Mono, monospace',
      fontSize: '0.62rem', fontWeight: 500,
      letterSpacing: '0.1em', textTransform: 'uppercase',
    }}>
      {esp}
    </span>
  )
}

function PodBadge({ qxDate }) {
  if (!qxDate) return null
  const days = Math.floor((Date.now() - new Date(qxDate).getTime()) / 86_400_000)
  if (days < 0 || days > 365) return null
  const label = days === 0 ? 'QX HOY' : `POD ${days}`
  const color = days <= 1 ? C.red : days <= 3 ? C.amber : C.green
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.2rem',
      padding: '0.12rem 0.45rem', borderRadius: '3px',
      background: color + '18', border: `1px solid ${color}35`,
      color, fontFamily: 'JetBrains Mono, monospace',
      fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em',
    }}>
      <i className="ph ph-calendar-blank" style={{ fontSize: '0.6rem' }} />
      {label}
    </span>
  )
}

// Auto-save textarea: saves on blur if the value changed
function NoteField({ label, field, value, onSave, rows = 3, accentColor, placeholder }) {
  const [draft, setDraft] = useState(value ?? '')
  const ref = useRef(null)

  useEffect(() => { setDraft(value ?? '') }, [value])

  function handleBlur() {
    const v = draft.trim()
    if (v !== (value ?? '').trim()) onSave(field, v)
  }

  const accent = accentColor ?? C.accent

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      {label && (
        <span style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
          letterSpacing: '0.2em', textTransform: 'uppercase', color: C.textMuted,
        }}>
          {label}
        </span>
      )}
      <textarea
        ref={ref}
        value={draft}
        rows={rows}
        placeholder={placeholder ?? 'Sin datos'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setDraft(value ?? ''); ref.current?.blur() }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ref.current?.blur()
        }}
        style={{
          width: '100%', background: C.bgBase,
          border: `1px solid ${C.borderGrid}`, borderRadius: '4px',
          padding: '0.5rem 0.65rem',
          color: draft ? C.textPrimary : C.textMuted,
          fontFamily: 'Satoshi, sans-serif', fontSize: '0.875rem',
          lineHeight: '1.6', resize: 'none', outline: 'none',
          transition: 'border-color 0.15s',
        }}
        onFocus={(e)       => (e.target.style.borderColor = accent)}
        onBlurCapture={(e) => (e.target.style.borderColor = C.borderGrid)}
      />
    </div>
  )
}

// Single lab cell: shows current value, delta arrow, and struck-through previous
function LabCell({ cfg, current, previous }) {
  const critical = isCritical(cfg, current)
  const dColor   = deltaColor(cfg, current, previous)
  const hasDelta = dColor !== null

  const cur = parseFloat(current)
  const pre = parseFloat(previous)
  const up  = hasDelta && cur > pre

  const valueColor = critical
    ? C.red
    : hasDelta
      ? dColor
      : C.accent

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '0.15rem',
      padding: '0.45rem 0.5rem',
      background: critical ? 'rgba(255,69,58,0.07)' : C.bgBase,
      border: `1px solid ${critical ? 'rgba(255,69,58,0.28)' : C.borderGrid}`,
      borderRadius: '4px',
    }}>
      {/* Analyte label */}
      <span style={{
        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem',
        letterSpacing: '0.18em', textTransform: 'uppercase', color: C.textMuted,
      }}>
        {cfg.label}
      </span>

      {/* Current value + arrow */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.15rem' }}>
        <span style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.92rem',
          fontWeight: 600, color: valueColor,
          lineHeight: 1,
        }}>
          {current ?? '—'}
        </span>
        {hasDelta && (
          <span style={{ fontSize: '0.72rem', color: dColor, lineHeight: 1 }}>
            {up ? '↑' : '↓'}
          </span>
        )}
      </div>

      {/* Previous value with strikethrough */}
      {hasDelta && (
        <span style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem',
          color: C.textMuted, textDecoration: 'line-through',
        }}>
          {previous}
        </span>
      )}
    </div>
  )
}

// Full labs grid — 5 + 5 layout
function LabsGrid({ labEntry }) {
  if (!labEntry) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.5rem',
        padding: '0.75rem 0', color: C.textMuted,
        fontFamily: 'Satoshi, sans-serif', fontSize: '0.82rem',
      }}>
        <i className="ph ph-flask" />
        Sin labs Winlab para este expediente
      </div>
    )
  }

  const reportes = labEntry.data?.reportes ?? []
  const latest   = flattenReporte(reportes[0])
  const prev     = flattenReporte(reportes[1])  // may be empty
  const hasDelta = reportes.length >= 2

  const scrapedAt = labEntry.scraped_at
    ? new Date(labEntry.scraped_at).toLocaleDateString('es-MX',
        { day: '2-digit', month: 'short', year: '2-digit' })
    : labEntry.fecha ?? '—'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <i className="ph ph-flask" style={{ color: C.accent, fontSize: '0.82rem' }} />
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
            letterSpacing: '0.18em', textTransform: 'uppercase', color: C.textMuted,
          }}>
            Winlab · {scrapedAt}
          </span>
        </div>
        {hasDelta && (
          <span style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem',
            letterSpacing: '0.1em', textTransform: 'uppercase',
            color: C.green, background: 'rgba(50,215,75,0.1)',
            border: '1px solid rgba(50,215,75,0.22)',
            borderRadius: '3px', padding: '0.1rem 0.4rem',
          }}>
            Δ evolución
          </span>
        )}
      </div>

      {/* 5-column grid × 2 rows */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: '0.35rem',
      }}>
        {LAB_CONFIG.map((cfg) => (
          <LabCell
            key={cfg.key}
            cfg={cfg}
            current={latest[cfg.key]}
            previous={hasDelta ? prev[cfg.key] : undefined}
          />
        ))}
      </div>
    </div>
  )
}

// Section block with a labeled header
function SectionBlock({ icon, title, accentColor, dimBg, children }) {
  const color = accentColor ?? C.accent
  return (
    <div style={{
      background: dimBg ? color + '0E' : C.bgPanel,
      border: `1px solid ${color}30`,
      borderRadius: '6px', padding: '0.8rem',
      display: 'flex', flexDirection: 'column', gap: '0.55rem',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.35rem',
        paddingBottom: '0.4rem', borderBottom: `1px solid ${color}20`,
      }}>
        <i className={`ph ph-${icon}`} style={{ color, fontSize: '0.85rem' }} />
        <span style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
          letterSpacing: '0.2em', textTransform: 'uppercase', color,
        }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  )
}

// ─── PatientCard ──────────────────────────────────────────────────────────────
export function PatientCard({ patient, note, labEntry, onSave }) {
  const [expanded, setExpanded] = useState(false)

  const { nombre, cama, exp, esp, dx } = patient
  const ck = note?.checklist ?? {}

  // Show hallazgos block if the key exists in checklist (even if empty string)
  const showHallazgos = 'hallazgos_transop' in ck

  return (
    <article
      data-testid={`patient-card-${exp}-${cama}`}
      style={{
        background: C.bgSurface,
        border: `1px solid ${C.borderDefault}`,
        borderRadius: '6px', overflow: 'hidden',
        transition: 'border-color 0.18s, box-shadow 0.18s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = C.borderFocus
        e.currentTarget.style.boxShadow   = '0 0 0 1px rgba(212,163,115,0.08)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = C.borderDefault
        e.currentTarget.style.boxShadow   = 'none'
      }}
    >

      {/* ── Collapsed header ──────────────────────────────────────────────── */}
      <div
        onClick={() => setExpanded((x) => !x)}
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto',
          alignItems: 'center', gap: '0.9rem',
          padding: '0.8rem 1rem', cursor: 'pointer', userSelect: 'none',
        }}
      >
        {/* Cama — oversized mono, left anchor */}
        <span style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '1.5rem', fontWeight: 400,
          color: C.textMuted, letterSpacing: '-0.03em',
          minWidth: '72px', lineHeight: 1,
        }}>
          {cama}
        </span>

        {/* Name + DX */}
        <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '0.12rem' }}>
          <span style={{
            fontFamily: 'Cabinet Grotesk, sans-serif',
            fontWeight: 700, fontSize: '1.0rem',
            color: C.textPrimary, letterSpacing: '-0.01em',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {nombre}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
              color: C.textMuted, letterSpacing: '0.06em',
            }}>
              {exp}
            </span>
            {dx && (
              <>
                <span style={{ color: C.borderDefault }}>·</span>
                <span style={{
                  fontFamily: 'Satoshi, sans-serif', fontSize: '0.78rem',
                  color: C.textSecondary,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {dx}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Right badges + chevron */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
          {esp && <EspBadge esp={esp} />}
          <PodBadge qxDate={ck.qx_date} />
          <i
            className={`ph ph-caret-${expanded ? 'up' : 'down'}`}
            style={{ color: C.textMuted, fontSize: '0.8rem', marginLeft: '0.2rem' }}
          />
        </div>
      </div>

      {/* ── Expanded body ─────────────────────────────────────────────────── */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${C.borderGrid}` }}>

          {/* ── QX + date ────────────────────────────────────────────────── */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr auto',
            alignItems: 'flex-end', gap: '0.75rem',
            padding: '0.75rem 1rem',
            borderBottom: `1px solid ${C.borderGrid}`,
          }}>
            <NoteField
              label="QX · Procedimiento"
              field="qx"
              value={note?.qx}
              onSave={onSave}
              rows={1}
              placeholder="Nombre del procedimiento quirúrgico..."
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flexShrink: 0 }}>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
                letterSpacing: '0.18em', textTransform: 'uppercase', color: C.textMuted,
              }}>
                Fecha QX
              </span>
              <input
                type="date"
                defaultValue={ck.qx_date ?? ''}
                onBlur={(e) => {
                  const v = e.target.value || null
                  if (v !== (ck.qx_date ?? null)) onSave('ck_qx_date', v)
                }}
                style={{
                  background: C.bgBase, border: `1px solid ${C.borderGrid}`,
                  borderRadius: '4px', padding: '0.45rem 0.6rem',
                  color: C.textPrimary, fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '0.8rem', outline: 'none', colorScheme: 'dark',
                }}
                onFocus={(e)       => (e.target.style.borderColor = C.accent)}
                onBlur={(e)        => (e.target.style.borderColor = C.borderGrid)}
              />
            </div>
          </div>

          {/* ── Labs Winlab ───────────────────────────────────────────────── */}
          <div style={{
            padding: '0.9rem 1rem',
            borderBottom: `1px solid ${C.borderGrid}`,
          }}>
            <LabsGrid labEntry={labEntry} />
          </div>

          {/* ── Hallazgos Transoperatorios ────────────────────────────────── */}
          {!showHallazgos ? (
            <div style={{ padding: '0.5rem 1rem', borderBottom: `1px solid ${C.borderGrid}` }}>
              <button
                onClick={() => onSave('ck_hallazgos_transop', '')}
                style={{
                  background: 'none',
                  border: `1px dashed ${C.accent}35`,
                  borderRadius: '4px', padding: '0.3rem 0.75rem',
                  color: C.accent, fontFamily: 'Satoshi, sans-serif',
                  fontSize: '0.78rem', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                  opacity: 0.65, transition: 'opacity 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.65')}
              >
                <i className="ph ph-eye" style={{ fontSize: '0.78rem' }} />
                Agregar hallazgos transoperatorios
              </button>
            </div>
          ) : (
            <div style={{
              margin: '0', padding: '0.8rem 1rem',
              background: C.accentDim,
              borderBottom: `1px solid ${C.borderGrid}`,
            }}>
              <NoteField
                label="Hallazgos Transoperatorios"
                field="ck_hallazgos_transop"
                value={ck.hallazgos_transop}
                onSave={onSave}
                rows={3}
                accentColor={C.accent}
                placeholder="Hallazgos intraoperatorios, anatomía, complicaciones..."
              />
            </div>
          )}

          {/* ── Sistemas ──────────────────────────────────────────────────── */}
          <div style={{
            padding: '0.9rem 1rem',
            display: 'flex', flexDirection: 'column', gap: '0.7rem',
          }}>

            {/* 2-column row: Ventilatorio + Hemodinámico */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.7rem' }}>
              <SectionBlock icon="lungs" title="Ventilatorio" accentColor={C.blue}>
                <NoteField
                  field="sv"
                  value={note?.sv}
                  onSave={onSave}
                  rows={3}
                  accentColor={C.blue}
                  placeholder="SatO2, FR, FiO2, modalidad..."
                />
              </SectionBlock>

              <SectionBlock icon="heartbeat" title="Hemodinámico" accentColor={C.red}>
                <NoteField
                  field="pa"
                  value={note?.pa}
                  onSave={onSave}
                  rows={3}
                  accentColor={C.red}
                  placeholder="FC, TA, PAM, ritmo..."
                />
              </SectionBlock>
            </div>

            {/* Renal — full width */}
            <SectionBlock icon="drop" title="Renal" accentColor={C.amber}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                <NoteField
                  label="Renal · Bioquímica"
                  field="ck_renal"
                  value={ck.renal}
                  onSave={onSave}
                  rows={3}
                  accentColor={C.amber}
                  placeholder="Cr, BUN, diuresis (mL/h), depuración..."
                />
                <NoteField
                  label="Balance Hídrico"
                  field="balance"
                  value={note?.balance}
                  onSave={onSave}
                  rows={3}
                  accentColor={C.amber}
                  placeholder="I: xxx mL · E: xxx mL · Neto: ..."
                />
              </div>
              <NoteField
                label="Drenajes · Diuresis"
                field="drenajes"
                value={note?.drenajes}
                onSave={onSave}
                rows={2}
                accentColor={C.amber}
                placeholder="Descripción de drenajes y gasto urinario..."
              />
            </SectionBlock>

            {/* Plan — emerald accent, prominent */}
            <SectionBlock
              icon="clipboard-text"
              title="Conducta · Plan"
              accentColor={C.emerald}
              dimBg
            >
              <NoteField
                field="manejo"
                value={note?.manejo}
                onSave={onSave}
                rows={5}
                accentColor={C.emerald}
                placeholder="Plan médico, conducta, indicaciones, siguiente QX..."
              />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                <NoteField
                  label="Pendientes"
                  field="pendientes"
                  value={note?.pendientes}
                  onSave={onSave}
                  rows={3}
                  accentColor={C.emerald}
                  placeholder="Labs, trámites, imagen..."
                />
                <NoteField
                  label="Interconsultas"
                  field="ck_interconsultas"
                  value={ck.interconsultas}
                  onSave={onSave}
                  rows={3}
                  accentColor={C.emerald}
                  placeholder="Especialidad · motivo..."
                />
              </div>
            </SectionBlock>

          </div>{/* /sistemas */}
        </div>
      )}
    </article>
  )
}
