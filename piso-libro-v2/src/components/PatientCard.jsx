/**
 * PatientCard — 7-zone Goodnotes surgical census card
 *
 * Props
 *   patient    { id, cama, nombre, exp, esp, dx, edad, sexo }
 *   note       { sv, pa, drenajes, qx, manejo, sangrado, balance,
 *                pendientes, misc, app, checklist{} }
 *   labHistory [currentScrape, previousScrape]  (winlab reportes array)
 *   onSave     (field: string, value: string) => void
 *              'ck_<key>' fields merge into checklist JSON
 */

import { useState, useEffect, useRef } from 'react'

// ─── Token shortcuts ──────────────────────────────────────────────────────────
const T = {
  base:    '#0A0A0B', surface: '#121214', panel:  '#171719',
  bDef:    '#27272A', bGrid:   '#1F1F22', bFocus: '#D4A373',
  txt:     '#F4F4F5', txt2:    '#A1A1AA', muted:  '#71717A',
  accent:  '#D4A373', acDim:   '#D4A37318',
  red:     '#FF453A', amber:   '#FF9F0A',
  green:   '#32D74B', blue:    '#0A84FF',
  emerald: '#34D399', emDim:   '#34D39912', emBorder: '#34D39935',
}

const ESP_COLOR = {
  CG:'#D4A373', CCR:'#a78bfa', CV:'#60a5fa', CT:'#34d399',
  CPR:'#f472b6', URO:'#fbbf24', NCX:'#f87171',
}

// ─── Lab configuration ────────────────────────────────────────────────────────
// direction: 1=higher-better  -1=lower-better  0=neutral
const LAB_CFG = [
  { key:'LEU',  label:'Leu',  unit:'k/µL', dir:-1, cLow:2,    cHigh:15   },
  { key:'HB',   label:'Hb',   unit:'g/dL', dir: 1, cLow:7,    cHigh:18   },
  { key:'PLAQ', label:'Plaq', unit:'k/µL', dir: 1, cLow:50,   cHigh:1000 },
  { key:'GLU',  label:'Glu',  unit:'mg/dL',dir: 0, cLow:60,   cHigh:400  },
  { key:'UREA', label:'Urea', unit:'mg/dL',dir:-1, cLow:null, cHigh:60   },
  { key:'CR',   label:'Cr',   unit:'mg/dL',dir:-1, cLow:null, cHigh:5    },
  { key:'NA',   label:'Na',   unit:'mEq/L',dir: 0, cLow:130,  cHigh:150  },
  { key:'K',    label:'K',    unit:'mEq/L',dir: 0, cLow:3.0,  cHigh:5.5  },
  { key:'CL',   label:'Cl',   unit:'mEq/L',dir: 0, cLow:95,   cHigh:110  },
  { key:'LAC',  label:'Lac',  unit:'mmol/L',dir:-1,cLow:null, cHigh:4    },
]

// Normalize raw winlab key → canonical key
const ALIAS = {
  LEUCOCITOS:'LEU',LEUCOS:'LEU',LEUCO:'LEU',WBC:'LEU',GB:'LEU',
  HEMOGLOBINA:'HB',HGB:'HB',HGL:'HB',
  PLAQUETAS:'PLAQ',PLT:'PLAQ',TROMBOCITOS:'PLAQ',
  GLUCOSA:'GLU',GLUCOSE:'GLU',
  UREA:'UREA',BUN:'UREA',
  CREATININA:'CR',CREAT:'CR',CREATININE:'CR',
  SODIO:'NA',SODIUM:'NA',
  POTASIO:'K',POTASSIUM:'K',
  CLORO:'CL',CLORURO:'CL',CHLORIDE:'CL',
  LACTATO:'LAC',LACTATE:'LAC','ACIDO LACTICO':'LAC','ÁCIDO LÁCTICO':'LAC',
  LEU:'LEU',HB:'HB',PLAQ:'PLAQ',GLU:'GLU',CR:'CR',
  NA:'NA',K:'K',CL:'CL',LAC:'LAC',
}

function flattenReporte(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  Object.entries(obj).forEach(([k, v]) => {
    const norm = String(k).toUpperCase().normalize('NFD')
      .replace(/[̀-ͯ]/g,'').replace(/[^A-Z0-9]/g,'')
    const canon = ALIAS[norm]
    if (canon && v != null && v !== '') out[canon] = String(v)
  })
  return out
}

function isCritical(cfg, val) {
  const v = parseFloat(val)
  if (isNaN(v)) return false
  if (cfg.cLow  != null && v < cfg.cLow)  return true
  if (cfg.cHigh != null && v > cfg.cHigh) return true
  return false
}

function deltaColor(cfg, cur, pre) {
  const c = parseFloat(cur), p = parseFloat(pre)
  if (isNaN(c) || isNaN(p) || Math.abs(c - p) < 0.001) return null
  if (cfg.dir === 0) return T.amber
  return ((cfg.dir === 1 && c > p) || (cfg.dir === -1 && c < p)) ? T.green : T.red
}

// ─── Primitives ───────────────────────────────────────────────────────────────

// Controlled textarea — saves on blur if value changed
function Field({ label, field, value, onSave, rows = 3, accent, mono, placeholder, style: sx }) {
  const [draft, setDraft] = useState(value ?? '')
  const ref = useRef(null)
  useEffect(() => { setDraft(value ?? '') }, [value])

  const ac = accent ?? T.accent

  function commit() {
    const v = draft.trim()
    if (v !== (value ?? '').trim()) onSave(field, v)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'0.28rem', ...sx }}>
      {label && (
        <span style={{
          fontFamily:'JetBrains Mono,monospace', fontSize:'0.58rem',
          letterSpacing:'0.2em', textTransform:'uppercase', color:T.muted,
        }}>{label}</span>
      )}
      <textarea
        ref={ref}
        value={draft}
        rows={rows}
        placeholder={placeholder ?? '—'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setDraft(value ?? ''); ref.current?.blur() }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ref.current?.blur()
        }}
        style={{
          width:'100%', background:T.base,
          border:`1px solid ${T.bGrid}`, borderRadius:'4px',
          padding:'0.45rem 0.6rem',
          color: draft ? T.txt : T.muted,
          fontFamily: mono ? 'JetBrains Mono,monospace' : 'Satoshi,sans-serif',
          fontSize: mono ? '0.8rem' : '0.875rem',
          lineHeight:'1.6', resize:'none', outline:'none',
          transition:'border-color 0.15s',
        }}
        onFocus={(e)       => (e.target.style.borderColor = ac)}
        onBlurCapture={(e) => (e.target.style.borderColor = T.bGrid)}
      />
    </div>
  )
}

// Compact single-line input — saves on blur
function Inp({ label, field, value, onSave, unit, width = '100%', accent, mono, type = 'text' }) {
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => { setDraft(value ?? '') }, [value])
  const ac = accent ?? T.accent

  function commit(v) {
    if (v !== (value ?? '')) onSave(field, v)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'0.2rem', width }}>
      {label && (
        <span style={{
          fontFamily:'JetBrains Mono,monospace', fontSize:'0.56rem',
          letterSpacing:'0.18em', textTransform:'uppercase', color:T.muted,
        }}>{label}{unit ? <span style={{ color:T.muted, marginLeft:'0.2rem', fontSize:'0.5rem' }}>{unit}</span> : null}</span>
      )}
      <input
        type={type}
        value={draft}
        placeholder="—"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value.trim())}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        style={{
          width:'100%', background:T.base,
          border:`1px solid ${T.bGrid}`, borderRadius:'4px',
          padding:'0.35rem 0.5rem',
          color: draft ? T.txt : T.muted,
          fontFamily: mono ? 'JetBrains Mono,monospace' : 'Satoshi,sans-serif',
          fontSize:'0.82rem', outline:'none',
          transition:'border-color 0.15s',
        }}
        onFocus={(e)       => (e.target.style.borderColor = ac)}
        onBlurCapture={(e) => (e.target.style.borderColor = T.bGrid)}
      />
    </div>
  )
}

// Zone label header
function ZoneLabel({ icon, title, color, right }) {
  const c = color ?? T.muted
  return (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'space-between',
      marginBottom:'0.5rem',
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:'0.35rem' }}>
        {icon && <i className={`ph ph-${icon}`} style={{ color:c, fontSize:'0.82rem' }} />}
        <span style={{
          fontFamily:'JetBrains Mono,monospace', fontSize:'0.58rem',
          letterSpacing:'0.2em', textTransform:'uppercase', color:c,
        }}>{title}</span>
      </div>
      {right}
    </div>
  )
}

// ─── Zone 2 — Intervention list ───────────────────────────────────────────────
function InterventionList({ value, field, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(value ?? '')
  const ref = useRef(null)

  useEffect(() => { setDraft(value ?? '') }, [value])

  function commit() {
    setEditing(false)
    const v = draft.trim()
    if (v !== (value ?? '').trim()) onSave(field, v)
  }

  const items = (value ?? '').split('\n').map((l) => l.trim()).filter(Boolean)

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={draft}
        autoFocus
        rows={Math.max(3, items.length + 1)}
        placeholder={'QX 1: Colecistectomía laparoscópica\nQx 2: Lavado y drenaje'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false) }
        }}
        style={{
          width:'100%', background:T.base,
          border:`1px solid ${T.bFocus}`, borderRadius:'4px',
          padding:'0.5rem 0.65rem', color:T.txt,
          fontFamily:'Satoshi,sans-serif', fontSize:'0.875rem',
          lineHeight:'1.6', resize:'none', outline:'none',
        }}
      />
    )
  }

  return (
    <div
      className="intervention-list"
      onClick={() => { setDraft(value ?? ''); setEditing(true) }}
      title="Clic para editar"
    >
      {items.length === 0 ? (
        <span style={{ color:T.muted, fontFamily:'Satoshi,sans-serif', fontSize:'0.85rem' }}>
          Sin intervenciones — clic para agregar
        </span>
      ) : (
        items.map((item, i) => (
          <div key={i} className="intervention-item">
            <span className="intervention-num">#{i + 1}</span>
            <span className="intervention-text">{item}</span>
          </div>
        ))
      )}
    </div>
  )
}

// ─── Zone 5 — Labs grid ───────────────────────────────────────────────────────
function LabCell({ cfg, cur, pre }) {
  const critical = isCritical(cfg, cur)
  const dColor   = deltaColor(cfg, cur, pre)
  const up       = dColor !== null && parseFloat(cur) > parseFloat(pre)

  const valColor = critical ? T.red : dColor ?? T.accent

  return (
    <div style={{
      display:'flex', flexDirection:'column', gap:'0.12rem',
      padding:'0.4rem 0.45rem',
      background: critical ? 'rgba(255,69,58,0.07)' : T.base,
      border:`1px solid ${critical ? 'rgba(255,69,58,0.3)' : T.bGrid}`,
      borderRadius:'4px',
    }}>
      <span style={{
        fontFamily:'JetBrains Mono,monospace', fontSize:'0.55rem',
        letterSpacing:'0.18em', textTransform:'uppercase', color:T.muted,
      }}>{cfg.label}</span>

      <div style={{ display:'flex', alignItems:'baseline', gap:'0.12rem' }}>
        <span style={{
          fontFamily:'JetBrains Mono,monospace', fontSize:'0.9rem',
          fontWeight:600, color:valColor, lineHeight:1,
        }}>
          {cur ?? '—'}
        </span>
        {dColor && (
          <span style={{ fontSize:'0.7rem', color:dColor, lineHeight:1 }}>
            {up ? '↑' : '↓'}
          </span>
        )}
      </div>

      {dColor && (
        <span style={{
          fontFamily:'JetBrains Mono,monospace', fontSize:'0.58rem',
          color:T.muted, textDecoration:'line-through',
        }}>{pre}</span>
      )}
    </div>
  )
}

function LabsGrid({ labHistory }) {
  const [current, previous] = labHistory ?? []
  const cur = flattenReporte(current)
  const pre = flattenReporte(previous)
  const hasDelta = !!previous

  const scrapedAt = current?.scraped_at ?? current?.fecha
  const dateLabel = scrapedAt
    ? new Date(scrapedAt).toLocaleDateString('es-MX', { day:'2-digit', month:'short' })
    : null

  return (
    <div>
      <ZoneLabel
        icon="flask"
        title={`Winlab${dateLabel ? ' · ' + dateLabel : ''}`}
        color={T.accent}
        right={hasDelta && (
          <span style={{
            fontFamily:'JetBrains Mono,monospace', fontSize:'0.56rem',
            letterSpacing:'0.1em', textTransform:'uppercase',
            color:T.green, background:'rgba(50,215,75,0.1)',
            border:'1px solid rgba(50,215,75,0.22)',
            borderRadius:'3px', padding:'0.1rem 0.4rem',
          }}>Δ evolución</span>
        )}
      />
      <div style={{
        display:'grid',
        gridTemplateColumns:'repeat(5, 1fr)',
        gap:'0.3rem',
      }}>
        {LAB_CFG.map((cfg) => (
          <LabCell key={cfg.key} cfg={cfg}
            cur={cur[cfg.key]} pre={hasDelta ? pre[cfg.key] : undefined} />
        ))}
      </div>
    </div>
  )
}

// ─── PatientCard ──────────────────────────────────────────────────────────────
export function PatientCard({ patient, note, labHistory, onSave }) {
  const [expanded, setExpanded] = useState(false)

  const { cama, nombre, exp, esp, dx } = patient
  const ck = note?.checklist ?? {}

  // Stable ID for BedNavigator scrollIntoView
  const anchorId = `bed-${String(cama).replace(/\s/g, '-')}`

  // POD
  const podDays = ck.qx_date
    ? Math.floor((Date.now() - new Date(ck.qx_date).getTime()) / 86_400_000)
    : null
  const podValid  = podDays != null && podDays >= 0 && podDays <= 365
  const podLabel  = podDays === 0 ? 'QX HOY' : `POD ${podDays}`
  const podColor  = podDays <= 1 ? T.red : podDays <= 3 ? T.amber : T.green

  const espColor = ESP_COLOR[esp] ?? T.muted

  const divider = <div style={{ height:'1px', background:T.bGrid, margin:'0.7rem 0' }} />

  return (
    <article
      id={anchorId}
      data-testid={`patient-card-${exp}-${cama}`}
      className="patient-card-anchor"
      style={{
        background:T.surface,
        border:`1px solid ${T.bDef}`,
        borderRadius:'6px', overflow:'hidden',
        transition:'border-color 0.18s, box-shadow 0.18s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = T.bFocus
        e.currentTarget.style.boxShadow = '0 0 0 1px rgba(212,163,115,0.07)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = T.bDef
        e.currentTarget.style.boxShadow = 'none'
      }}
    >

      {/* ── ZONA 0 — Header ──────────────────────────────────────────────── */}
      <div
        onClick={() => setExpanded((x) => !x)}
        style={{
          display:'grid',
          gridTemplateColumns:'auto 1fr auto',
          alignItems:'center', gap:'0.85rem',
          padding:'0.75rem 1rem', cursor:'pointer', userSelect:'none',
        }}
      >
        {/* Cama — oversized anchor */}
        <span style={{
          fontFamily:'JetBrains Mono,monospace',
          fontSize:'1.6rem', fontWeight:400,
          color:T.muted, letterSpacing:'-0.04em',
          minWidth:'74px', lineHeight:1,
        }}>{cama}</span>

        {/* Name + exp */}
        <div style={{ overflow:'hidden' }}>
          <p style={{
            margin:0, fontFamily:'Cabinet Grotesk,sans-serif',
            fontWeight:700, fontSize:'1rem', color:T.txt,
            letterSpacing:'-0.01em',
            whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
          }}>{nombre}</p>
          <p style={{
            margin:0, fontFamily:'JetBrains Mono,monospace',
            fontSize:'0.7rem', color:T.muted, letterSpacing:'0.05em',
          }}>{exp}</p>
        </div>

        {/* Badges + chevron */}
        <div style={{ display:'flex', alignItems:'center', gap:'0.4rem', flexShrink:0 }}>
          {esp && (
            <span style={{
              padding:'0.12rem 0.45rem', borderRadius:'20px',
              background:espColor+'18', border:`1px solid ${espColor}35`,
              color:espColor, fontFamily:'JetBrains Mono,monospace',
              fontSize:'0.6rem', fontWeight:600, letterSpacing:'0.1em', textTransform:'uppercase',
            }}>{esp}</span>
          )}
          {podValid && (
            <span style={{
              display:'inline-flex', alignItems:'center', gap:'0.2rem',
              padding:'0.12rem 0.45rem', borderRadius:'20px',
              background:podColor+'15', border:`1px solid ${podColor}35`,
              color:podColor, fontFamily:'JetBrains Mono,monospace',
              fontSize:'0.6rem', fontWeight:700, letterSpacing:'0.08em',
            }}>
              <i className="ph ph-calendar-blank" style={{ fontSize:'0.6rem' }} />
              {podLabel}
            </span>
          )}
          <i className={`ph ph-caret-${expanded ? 'up' : 'down'}`}
             style={{ color:T.muted, fontSize:'0.8rem' }} />
        </div>
      </div>

      {/* ── EXPANDED BODY ──────────────────────────────────────────────────── */}
      {expanded && (
        <div style={{ borderTop:`1px solid ${T.bGrid}`, padding:'0.85rem 1rem' }}>

          {/* ── ZONA 1 — Contexto Base (Dx + APP) ──────────────────────── */}
          <ZoneLabel icon="clipboard-text" title="Contexto Clínico" color={T.accent} />
          <div style={{
            background:T.acDim,
            border:`1px solid ${T.bFocus}30`,
            borderRadius:'6px', padding:'0.75rem',
            display:'flex', flexDirection:'column', gap:'0.65rem',
          }}>
            <Field
              label="Dx · Motivo de ingreso"
              field="dx_note"
              value={note?.misc}           // dx is a patient column — we use misc for long-form DX notes
              onSave={onSave}
              rows={2}
              accent={T.accent}
              placeholder={dx ?? 'Diagnóstico principal…'}
            />
            <Field
              label="APP · Antecedentes"
              field="app"
              value={note?.app}
              onSave={onSave}
              rows={3}
              accent={T.accent}
              placeholder="Comorbilidades, alergias, medicamentos previos…"
            />
          </div>

          {divider}

          {/* ── ZONA 2 — Lista de Intervenciones ───────────────────────── */}
          <ZoneLabel icon="knife" title="Historial Quirúrgico" color={T.txt2} />
          <div style={{
            display:'grid', gridTemplateColumns:'1fr auto',
            alignItems:'flex-end', gap:'0.6rem', marginBottom:'0.5rem',
          }}>
            <InterventionList field="qx" value={note?.qx} onSave={onSave} />
            <div style={{ flexShrink:0 }}>
              <span style={{
                fontFamily:'JetBrains Mono,monospace', fontSize:'0.56rem',
                letterSpacing:'0.18em', textTransform:'uppercase',
                color:T.muted, display:'block', marginBottom:'0.25rem',
              }}>Fecha QX</span>
              <input
                type="date"
                defaultValue={ck.qx_date ?? ''}
                onBlur={(e) => {
                  const v = e.target.value || null
                  if (v !== (ck.qx_date ?? null)) onSave('ck_qx_date', v)
                }}
                style={{
                  background:T.base, border:`1px solid ${T.bGrid}`,
                  borderRadius:'4px', padding:'0.38rem 0.55rem',
                  color:T.txt, fontFamily:'JetBrains Mono,monospace',
                  fontSize:'0.78rem', outline:'none', colorScheme:'dark',
                }}
                onFocus={(e)       => (e.target.style.borderColor = T.accent)}
                onBlurCapture={(e) => (e.target.style.borderColor = T.bGrid)}
              />
            </div>
          </div>

          {divider}

          {/* ── ZONA 3 — Egresos (una sola fila proporcional) ──────────── */}
          <ZoneLabel icon="drop-half" title="Egresos" color={T.amber} />
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr auto', gap:'0.5rem' }}>
            <Field
              label="Drenajes"
              field="drenajes"
              value={note?.drenajes}
              onSave={onSave}
              rows={2}
              mono
              accent={T.amber}
              placeholder="Jackson–Pratt, Penrose, aspirativo…"
            />
            <Field
              label="Balance"
              field="balance"
              value={note?.balance}
              onSave={onSave}
              rows={2}
              mono
              accent={T.amber}
              placeholder="I: / E: / Neto:"
            />
            <div style={{ display:'flex', flexDirection:'column', justifyContent:'flex-end' }}>
              <Inp
                label="Sangrado"
                field="sangrado"
                value={note?.sangrado}
                onSave={onSave}
                unit="mL"
                mono
                accent={T.red}
              />
            </div>
          </div>

          {divider}

          {/* ── ZONA 4 — Checklist Táctico ──────────────────────────────── */}
          <ZoneLabel icon="check-square" title="Checklist Táctico" color={T.green} />
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'0.5rem' }}>
            <Inp label="Dieta"          field="ck_dieta" value={ck.dieta}
                 onSave={onSave} accent={T.green} />
            <Inp label="ATB"            field="ck_atb"   value={ck.atb}
                 onSave={onSave} accent={T.green} />
            <Inp label="Profilaxis TVP" field="ck_tvp"   value={ck.tvp}
                 onSave={onSave} accent={T.green} />
          </div>

          {divider}

          {/* ── ZONA 5 — Labs Winlab ────────────────────────────────────── */}
          <LabsGrid labHistory={labHistory} />

          {divider}

          {/* ── ZONA 6 — Signos Vitales (miniatura) ────────────────────── */}
          <ZoneLabel icon="heartbeat" title="Signos Vitales" color={T.red} />
          <div style={{
            display:'grid',
            gridTemplateColumns:'repeat(6, 1fr)',
            gap:'0.4rem',
          }}>
            <Inp label="FC"    unit="lpm"  field="ck_fc"    value={ck.fc}    onSave={onSave} mono accent={T.red} />
            <Inp label="FR"    unit="rpm"  field="ck_fr"    value={ck.fr}    onSave={onSave} mono accent={T.blue} />
            <Inp label="TA"    unit="mmHg" field="ck_ta"    value={ck.ta}    onSave={onSave} mono accent={T.red} />
            <Inp label="Temp"  unit="°C"   field="ck_temp"  value={ck.temp}  onSave={onSave} mono accent={T.amber} />
            <Inp label="SaO₂"  unit="%"    field="ck_sao2"  value={ck.sao2}  onSave={onSave} mono accent={T.blue} />
            <Inp label="Uresis" unit="mL/h" field="ck_uresis" value={ck.uresis} onSave={onSave} mono accent={T.amber} />
          </div>

          {divider}

          {/* ── ZONA 7 — Conducta (esmeralda) ───────────────────────────── */}
          <div style={{
            background:T.emDim,
            border:`1px solid ${T.emBorder}`,
            borderRadius:'6px', padding:'0.75rem',
            display:'flex', flexDirection:'column', gap:'0.65rem',
          }}>
            <ZoneLabel icon="clipboard-text" title="Conducta · Plan" color={T.emerald} />
            <Field
              field="manejo"
              value={note?.manejo}
              onSave={onSave}
              rows={5}
              accent={T.emerald}
              placeholder="Plan médico, conducta, siguiente QX, indicaciones…"
            />
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.6rem' }}>
              <Field
                label="Pendientes"
                field="pendientes"
                value={note?.pendientes}
                onSave={onSave}
                rows={3}
                accent={T.emerald}
                placeholder="Labs, trámites, imagen…"
              />
              <Field
                label="Interconsultas"
                field="ck_interconsultas"
                value={ck.interconsultas}
                onSave={onSave}
                rows={3}
                accent={T.emerald}
                placeholder="Especialidad · motivo…"
              />
            </div>
          </div>

        </div>
      )}
    </article>
  )
}
