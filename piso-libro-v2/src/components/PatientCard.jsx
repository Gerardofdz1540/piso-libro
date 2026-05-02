import { useState, useRef, useCallback, useEffect } from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────
const PRIMARY_SERVICES = ['CG', 'CT', 'CCR', 'CV', 'GASTRO']

const ESP_COLOR = {
  CG: '#D4A373', CCR: '#a78bfa', CV: '#60a5fa',
  CT: '#34d399', CPR: '#f472b6', URO: '#fbbf24', NCX: '#f87171',
  GASTRO: '#fb923c',
}

const LAB_PANELS = [
  { key: 'hb',   label: 'Hb',   unit: 'g/dL',  ref: [12, 17.5], inverted: false },
  { key: 'leu',  label: 'Leu',  unit: 'K/µL',  ref: [4.5, 11],  inverted: true  },
  { key: 'plaq', label: 'Plaq', unit: 'K/µL',  ref: [150, 400], inverted: false },
  { key: 'glu',  label: 'Glu',  unit: 'mg/dL', ref: [70, 100],  inverted: true  },
  { key: 'urea', label: 'Urea', unit: 'mg/dL', ref: [10, 50],   inverted: true  },
  { key: 'cr',   label: 'Cr',   unit: 'mg/dL', ref: [0.6, 1.2], inverted: true  },
  { key: 'na',   label: 'Na',   unit: 'mEq/L', ref: [136, 145], inverted: false },
  { key: 'k',    label: 'K',    unit: 'mEq/L', ref: [3.5, 5.1], inverted: false },
  { key: 'lac',  label: 'Lac',  unit: 'mmol/L',ref: [0.5, 2.0], inverted: true  },
]

const ALIAS = {
  leucocitos:'leu', globulos_blancos:'leu', wbc:'leu',
  hemoglobina:'hb', hgb:'hb',
  plaquetas:'plaq', plt:'plaq',
  glucosa:'glu', glucose:'glu',
  urea:'urea', bun:'urea',
  creatinina:'cr', creatinine:'cr',
  sodio:'na', sodium:'na',
  potasio:'k', potassium:'k',
  lactato:'lac', lactate:'lac', lactico:'lac',
}

function normalizeKey(raw) {
  const k = raw.toLowerCase()
    .replace(/\s+/g,'_')
    .replace(/[áéíóú]/g, c => ({á:'a',é:'e',í:'i',ó:'o',ú:'u'})[c] ?? c)
  return ALIAS[k] ?? k
}

function parseLabReport(report) {
  if (!report) return {}
  const result = {}
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) { obj.forEach(walk); return }
    for (const [k, v] of Object.entries(obj)) {
      const nk = normalizeKey(k)
      if (typeof v === 'number') result[nk] = v
      else if (typeof v === 'string') {
        const n = parseFloat(v.replace(',','.'))
        if (!isNaN(n)) result[nk] = n
      } else walk(v)
    }
  }
  walk(report)
  return result
}

// ─── Primitives ───────────────────────────────────────────────────────────────
function EditableField({ field, value, onSave, placeholder='', rows=3, className='', accentColor }) {
  const [local, setLocal] = useState(value ?? '')
  const dirty = useRef(false)

  useEffect(() => { if (!dirty.current) setLocal(value ?? '') }, [value])

  const commit = useCallback(() => {
    if (dirty.current) { onSave(field, local); dirty.current = false }
  }, [field, local, onSave])

  return (
    <textarea
      rows={rows}
      value={local}
      placeholder={placeholder}
      onChange={e => { setLocal(e.target.value); dirty.current = true }}
      onBlur={commit}
      className={`w-full bg-transparent resize-none text-xs text-[#E4E4E7] placeholder-[#3f3f46] font-mono leading-relaxed focus:outline-none ${className}`}
      style={accentColor ? { caretColor: accentColor } : {}}
    />
  )
}

function MiniInput({ field, value, onSave, placeholder='', width='w-16' }) {
  const [local, setLocal] = useState(value ?? '')
  const dirty = useRef(false)

  useEffect(() => { if (!dirty.current) setLocal(value ?? '') }, [value])

  const commit = useCallback(() => {
    if (dirty.current) { onSave(field, local); dirty.current = false }
  }, [field, local, onSave])

  return (
    <input
      value={local}
      placeholder={placeholder}
      onChange={e => { setLocal(e.target.value); dirty.current = true }}
      onBlur={commit}
      className={`${width} bg-[#0f0f10] border border-[#1f1f22] rounded text-[11px] font-mono text-[#E4E4E7] placeholder-[#3f3f46] px-1.5 py-0.5 focus:outline-none focus:border-[#D4A373]`}
    />
  )
}

function InlineField({ label, field, value, onSave }) {
  const [local, setLocal] = useState(value ?? '')
  const dirty = useRef(false)

  useEffect(() => { if (!dirty.current) setLocal(value ?? '') }, [value])

  const commit = useCallback(() => {
    if (dirty.current) { onSave(field, local); dirty.current = false }
  }, [field, local, onSave])

  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] font-mono text-[#6B7280] w-10 flex-shrink-0">{label}</span>
      <input
        value={local}
        onChange={e => { setLocal(e.target.value); dirty.current = true }}
        onBlur={commit}
        className="flex-1 bg-[#0a0a0b] border border-[#1f1f22] rounded text-[11px] font-mono text-[#E4E4E7] placeholder-[#3f3f46] px-2 py-0.5 focus:outline-none focus:border-[#D4A373]"
      />
    </div>
  )
}

function FieldBlock({ label, field, value, onSave, placeholder, rows=3, accentColor }) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <span className="text-[9px] font-mono uppercase tracking-widest"
              style={{ color: accentColor ?? '#6B7280' }}>
          {label}
        </span>
      )}
      <div className="bg-[#0a0a0b] border border-[#1f1f22] rounded p-2"
           style={accentColor ? { borderColor: `${accentColor}30` } : {}}>
        <EditableField field={field} value={value} onSave={onSave}
                       placeholder={placeholder} rows={rows} accentColor={accentColor} />
      </div>
    </div>
  )
}

// ─── LabCell ──────────────────────────────────────────────────────────────────
function LabCell({ panel, current, previous }) {
  const val  = current?.[panel.key]
  const prev = previous?.[panel.key]

  if (val == null) {
    return (
      <div className="flex flex-col items-center py-1 px-1.5">
        <span className="text-[10px] font-mono text-[#3f3f46]">{panel.label}</span>
        <span className="text-xs font-mono text-[#3f3f46]">—</span>
      </div>
    )
  }

  const [lo, hi] = panel.ref
  const outOfRange = val < lo || val > hi
  let color = outOfRange ? '#EF4444' : '#34D399'

  let arrow = null, arrowColor = '#6B7280'
  if (prev != null) {
    const diff = val - prev
    const threshold = Math.abs(prev) * 0.03
    if (Math.abs(diff) > threshold) {
      const up = diff > 0
      arrow = up ? '↑' : '↓'
      const good = panel.inverted ? !up : up
      arrowColor = good ? '#34D399' : '#EF4444'
      if (!outOfRange) color = arrowColor
    }
  }

  return (
    <div className="flex flex-col items-center py-1 px-1.5">
      <span className="text-[10px] font-mono text-[#6B7280]">{panel.label}</span>
      <div className="flex items-baseline gap-0.5">
        <span className="text-xs font-mono font-semibold" style={{ color }}>{val}</span>
        {arrow && <span className="text-[10px] font-mono font-bold" style={{ color: arrowColor }}>{arrow}</span>}
      </div>
    </div>
  )
}

// ─── SOAP Modal ───────────────────────────────────────────────────────────────
function NotaModal({ pt, onClose }) {
  const today = new Date().toLocaleDateString('es-MX', { day:'2-digit', month:'2-digit', year:'numeric' })
  const vs = [
    pt.fc    ? `FC ${pt.fc} lpm`      : null,
    pt.fr    ? `FR ${pt.fr} rpm`      : null,
    pt.ta    ? `TA ${pt.ta} mmHg`     : null,
    pt.temp  ? `Temp ${pt.temp} °C`   : null,
    pt.sao2  ? `SatO2 ${pt.sao2}%`    : null,
    pt.uresis? `Diuresis ${pt.uresis} mL` : null,
  ].filter(Boolean).join(', ')

  const nota = [
    `NOTA DE EVOLUCIÓN — ${today}`,
    `Paciente: ${pt.nombre ?? ''}  |  Cama: ${pt.cama}  |  Exp: ${pt.exp ?? ''}`,
    `Servicio: ${pt.esp ?? ''}  |  Adscrito: ${pt.adscrito ?? ''}  |  R: ${pt.r_cargo ?? ''}`,
    '',
    `DIAGNÓSTICO PRINCIPAL: ${pt.dx ?? ''}`,
    pt.qx_procedimiento ? `PROCEDIMIENTO: ${pt.qx_procedimiento}` : null,
    '',
    '━━━ SUBJETIVO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    pt.app ?? 'Paciente refiere…',
    '',
    '━━━ OBJETIVO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `Signos vitales: ${vs || 'No registrados'}`,
    pt.balance ? `Balance hídrico: ${pt.balance}` : null,
    'Exploración física:',
    pt.pa ?? '(Sin exploración registrada)',
    `Drenajes: ${pt.drenajes ?? 'Sin drenajes'}`,
    pt.sangrado ? `Sangrado: ${pt.sangrado}` : null,
    '',
    '━━━ ANÁLISIS / LABORATORIOS ━━━━━━━━━━━━━━━━━━━━━━━',
    pt.sv ?? '(Sin laboratorios recientes)',
    '',
    '━━━ PLAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    pt.manejo ?? '(Sin plan registrado)',
    pt.pendientes ? `\nPendientes:\n${pt.pendientes}` : null,
    pt.dieta ? `\nDieta: ${pt.dieta}` : null,
    pt.atb   ? `ATB: ${pt.atb}`       : null,
    pt.tvp   ? `TVP: ${pt.tvp}`       : null,
    '',
    'Firma: ______________________  Matrícula: ______',
  ].filter(v => v !== null).join('\n')

  function copy() { navigator.clipboard.writeText(nota).catch(() => {}) }

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
         onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-[#0f0f10] border border-[#1f1f22] rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f22]">
          <span className="font-mono text-xs text-[#D4A373] uppercase tracking-widest">SOAP · {pt.cama}</span>
          <div className="flex gap-2">
            <button onClick={copy}
                    className="text-xs font-mono text-[#6B7280] hover:text-[#F4F4F5] border border-[#1f1f22] rounded px-3 py-1">
              Copiar
            </button>
            <button onClick={onClose} className="text-xs font-mono text-[#6B7280] hover:text-[#F4F4F5]">✕</button>
          </div>
        </div>
        <pre className="flex-1 overflow-y-auto px-4 py-3 text-[11px] font-mono text-[#A1A1AA] whitespace-pre-wrap leading-relaxed">
          {nota}
        </pre>
      </div>
    </div>
  )
}

// ─── GuestCard ────────────────────────────────────────────────────────────────
function GuestCard({ pt, onSave }) {
  const color = ESP_COLOR[pt.esp] ?? '#6B7280'
  return (
    <div id={`bed-${String(pt.cama).replace(/\s/g, '-')}`}
         className="bg-[#0f0f10] border border-[#1f1f22] rounded-lg px-4 py-2.5 flex items-center gap-3"
         style={{ borderLeftColor: color, borderLeftWidth: 2 }}>
      <span className="font-mono text-xs font-bold" style={{ color }}>{pt.cama}</span>
      <span className="font-mono text-[9px] px-1.5 py-0.5 rounded-full"
            style={{ background: `${color}18`, color }}>
        {pt.esp ?? '—'}
      </span>
      <span className="text-xs text-[#E4E4E7] flex-1 truncate min-w-0">
        {pt.nombre ?? <span className="text-[#3f3f46]">Sin nombre</span>}
      </span>
      <span className="text-[11px] text-[#6B7280] truncate max-w-[200px] hidden sm:block">{pt.dx ?? ''}</span>
      <MiniInput field="manejo" value={pt.manejo} onSave={onSave} placeholder="conducta…" width="w-40" />
    </div>
  )
}

// ─── EmptyBedCard ─────────────────────────────────────────────────────────────
function EmptyBedCard({ cama }) {
  return (
    <div id={`bed-${String(cama).replace(/\s/g, '-')}`}
         className="bg-[#0a0a0b] border border-dashed border-[#1f1f22] rounded-lg px-4 py-1.5 flex items-center gap-3 opacity-30">
      <span className="font-mono text-xs text-[#3f3f46]">{cama}</span>
      <span className="text-[10px] text-[#2a2a2e]">Cama libre</span>
    </div>
  )
}

// ─── VitalsRow ────────────────────────────────────────────────────────────────
function VitalsRow({ pt, onSave }) {
  const fields = [
    { field:'fc',     label:'FC',   unit:'lpm',  w:'w-12' },
    { field:'fr',     label:'FR',   unit:'rpm',  w:'w-12' },
    { field:'ta',     label:'TA',   unit:'mmHg', w:'w-20' },
    { field:'temp',   label:'T°',   unit:'°C',   w:'w-14' },
    { field:'sao2',   label:'SaO2', unit:'%',    w:'w-12' },
    { field:'uresis', label:'Diur', unit:'mL',   w:'w-16' },
    { field:'balance',label:'Bal',  unit:'mL',   w:'w-20' },
  ]
  return (
    <>
      {fields.map(f => (
        <div key={f.field} className="flex items-center gap-1">
          <span className="text-[9px] font-mono text-[#6B7280]">{f.label}</span>
          <MiniInput field={f.field} value={pt[f.field]} onSave={onSave} placeholder="—" width={f.w} />
          <span className="text-[9px] font-mono text-[#3f3f46]">{f.unit}</span>
        </div>
      ))}
    </>
  )
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function EvolucionTab({ pt, onSave }) {
  return (
    <div className="flex flex-col gap-3">
      <FieldBlock label="APP / Subjetivo" field="app" value={pt.app} onSave={onSave}
                  placeholder="Motivo de ingreso, evolución subjetiva…" rows={3} />
      <FieldBlock label="Exploración Física" field="pa" value={pt.pa} onSave={onSave}
                  placeholder="SOMATOMETRÍA, cabeza, cuello, tórax, abdomen, extremidades…" rows={5} />
      <div className="grid grid-cols-2 gap-3">
        <FieldBlock label="Drenajes / Herida" field="drenajes" value={pt.drenajes} onSave={onSave}
                    placeholder="JPH1, JPH2, URO, herida…" rows={3} />
        <FieldBlock label="Sangrado / Hemostasia" field="sangrado" value={pt.sangrado} onSave={onSave}
                    placeholder="Sangrado trans, evolución, hemostasia…" rows={3} />
      </div>
      <FieldBlock label="Signos / Labs (texto libre)" field="sv" value={pt.sv} onSave={onSave}
                  placeholder="Interpretación de labs, signos, tendencia…" rows={3} />
    </div>
  )
}

function PlanTab({ pt, onSave }) {
  return (
    <div className="flex flex-col gap-3">
      <FieldBlock label="Conducta / Plan" field="manejo" value={pt.manejo} onSave={onSave}
                  accentColor="#34D399"
                  placeholder="Plan médico, indicaciones, cirugía programada…" rows={5} />
      <div className="grid grid-cols-2 gap-3">
        <FieldBlock label="Pendientes" field="pendientes" value={pt.pendientes} onSave={onSave}
                    accentColor="#F59E0B"
                    placeholder="Estudios, trámites…" rows={4} />
        <div className="flex flex-col gap-2 bg-[#0a0a0b] border border-[#1f1f22] rounded p-2">
          <InlineField label="Dieta" field="dieta" value={pt.dieta} onSave={onSave} />
          <InlineField label="ATB"   field="atb"   value={pt.atb}   onSave={onSave} />
          <InlineField label="TVP"   field="tvp"   value={pt.tvp}   onSave={onSave} />
          <InlineField label="NPT"   field="npt"   value={pt.npt}   onSave={onSave} />
        </div>
      </div>
      <FieldBlock label="Notas / Misc" field="misc" value={pt.misc} onSave={onSave}
                  placeholder="Observaciones, notas de guardia…" rows={2} />
    </div>
  )
}

function QxTab({ pt, onSave }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <InlineField label="Fecha QX"     field="qx_date"          value={pt.qx_date}          onSave={onSave} />
        <InlineField label="Proc."        field="qx_procedimiento"  value={pt.qx_procedimiento} onSave={onSave} />
      </div>
      <FieldBlock label="Hallazgos quirúrgicos" field="qx_hallazgos" value={pt.qx_hallazgos} onSave={onSave}
                  placeholder="Hallazgos intraoperatorios…" rows={4} />
      <div className="grid grid-cols-2 gap-3">
        <FieldBlock label="Sangrado QX" field="qx_sangrado" value={pt.qx_sangrado} onSave={onSave}
                    placeholder="mL estimados…" rows={2} />
        <FieldBlock label="Antecedentes quirúrgicos" field="qx" value={pt.qx} onSave={onSave}
                    placeholder="Cirugías previas, fechas…" rows={2} />
      </div>
    </div>
  )
}

function GuardiaTab({ pt, onSave }) {
  function autoGen() {
    const lines = [
      `CAMA ${pt.cama} — ${pt.nombre ?? ''}`,
      pt.dx               ? `Dx: ${pt.dx}` : null,
      pt.qx_procedimiento ? `QX: ${pt.qx_procedimiento}` : null,
      pt.manejo           ? `Plan: ${pt.manejo}` : null,
      pt.pendientes       ? `Pendientes: ${pt.pendientes}` : null,
    ].filter(Boolean).join('\n')
    onSave('guardia_entrega', lines)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <FieldBlock label="Tareas MIP" field="tareas_mip" value={pt.tareas_mip} onSave={onSave}
                    accentColor="#3B82F6" placeholder="Tareas para el médico interno…" rows={4} />
        <FieldBlock label="Tareas R1"  field="tareas_r1"  value={pt.tareas_r1}  onSave={onSave}
                    accentColor="#a78bfa" placeholder="Tareas para el residente…" rows={4} />
      </div>
      <FieldBlock label="Recibes (al entrar)" field="guardia_recibes" value={pt.guardia_recibes} onSave={onSave}
                  placeholder="Estado al inicio de guardia…" rows={3} />
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-mono text-[#6B7280] uppercase tracking-widest">Entrega (al salir)</span>
          <button onClick={autoGen}
                  className="text-[9px] font-mono text-[#6B7280] hover:text-[#D4A373] border border-[#1f1f22] rounded px-2 py-0.5">
            Auto-generar
          </button>
        </div>
        <div className="bg-[#0a0a0b] border border-[#1f1f22] rounded p-2">
          <EditableField field="guardia_entrega" value={pt.guardia_entrega} onSave={onSave}
                         placeholder="Resumen al entregar guardia…" rows={4} />
        </div>
      </div>
    </div>
  )
}

// ─── PatientCard ──────────────────────────────────────────────────────────────
export function PatientCard({ patient: pt, isWeekendMode, onSave }) {
  const [expanded,  setExpanded]  = useState(false)
  const [activeTab, setActiveTab] = useState('evolucion')
  const [showNota,  setShowNota]  = useState(false)
  const [labIndex,  setLabIndex]  = useState(0)

  if (pt._empty) return <EmptyBedCard cama={pt.cama} />

  const isGuest = pt.esp && !PRIMARY_SERVICES.includes(pt.esp)
  if (isGuest) return <GuestCard pt={pt} onSave={onSave} />

  const color = ESP_COLOR[pt.esp] ?? '#D4A373'

  const labHistory  = Array.isArray(pt.labs_history) ? pt.labs_history : []
  const currentLab  = parseLabReport(labHistory[labIndex]     ?? null)
  const previousLab = parseLabReport(labHistory[labIndex + 1] ?? null)
  const labDates    = labHistory.map((r, i) => {
    const d = r?.fecha ?? r?.date ?? r?.scraped_at ?? `#${i}`
    return typeof d === 'string' ? d.slice(0, 10) : `#${i}`
  })

  const tabs = [
    { id:'evolucion', label:'Evolución' },
    { id:'plan',      label:'Plan'      },
    { id:'qx',        label:'QX'        },
    { id:'guardia',   label:'Guardia'   },
  ]

  return (
    <>
      {showNota && <NotaModal pt={pt} onClose={() => setShowNota(false)} />}

      <div
        id={`bed-${String(pt.cama).replace(/\s/g, '-')}`}
        className="bg-[#0f0f10] border border-[#1f1f22] rounded-lg overflow-hidden"
        style={{ borderLeftColor: color, borderLeftWidth: 2 }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1f1f22] cursor-pointer select-none"
             onClick={() => setExpanded(e => !e)}>
          <span className="font-mono text-xs font-bold flex-shrink-0" style={{ color }}>{pt.cama}</span>
          <span className="font-mono text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0"
                style={{ background:`${color}18`, color }}>
            {pt.esp ?? '—'}
          </span>
          <span className="text-xs font-semibold text-[#F4F4F5] truncate flex-1 min-w-0">
            {pt.nombre ?? <span className="text-[#3f3f46] font-normal">Sin paciente</span>}
          </span>
          <span className="text-[11px] text-[#6B7280] truncate max-w-[200px] hidden sm:block flex-shrink-0">
            {pt.dx ?? ''}
          </span>

          {isWeekendMode && (
            <button
              onClick={e => { e.stopPropagation(); onSave('nota_hecha', !pt.nota_hecha) }}
              title="Marcar nota FDS"
              className="text-sm leading-none flex-shrink-0 transition-opacity"
              style={{ opacity: pt.nota_hecha ? 1 : 0.25 }}
            >
              ✓
            </button>
          )}

          <button
            onClick={e => { e.stopPropagation(); setShowNota(true) }}
            className="text-[10px] font-mono text-[#6B7280] hover:text-[#D4A373] transition-colors flex-shrink-0 hidden sm:block"
          >
            SOAP
          </button>

          <span className="text-[#3f3f46] text-[10px] flex-shrink-0">{expanded ? '▲' : '▼'}</span>
        </div>

        {/* Vitals strip (always visible for occupied beds) */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-b border-[#1f1f22]">
          <VitalsRow pt={pt} onSave={onSave} />
        </div>

        {/* Expanded content */}
        {expanded && (
          <>
            {/* Labs strip */}
            {labHistory.length > 0 && (
              <div className="border-b border-[#1f1f22]">
                <div className="flex items-center gap-2 px-3 pt-1.5 pb-1">
                  <span className="text-[9px] font-mono text-[#6B7280] uppercase tracking-widest">Labs</span>
                  {labDates.length > 1 && (
                    <div className="flex gap-1">
                      {labDates.slice(0, 4).map((d, i) => (
                        <button key={i} onClick={() => setLabIndex(i)}
                                className="text-[9px] font-mono px-1.5 py-0.5 rounded border transition-all"
                                style={{
                                  borderColor: labIndex===i ? `${color}60` : '#1f1f22',
                                  color: labIndex===i ? color : '#6B7280',
                                  background: labIndex===i ? `${color}10` : 'transparent',
                                }}>
                          {d}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap divide-x divide-[#1f1f22] border-t border-[#1f1f22]">
                  {LAB_PANELS.map(panel => (
                    <LabCell key={panel.key} panel={panel} current={currentLab} previous={previousLab} />
                  ))}
                </div>
              </div>
            )}

            {/* Tabs */}
            <div>
              <div className="flex border-b border-[#1f1f22] px-3 gap-0 pt-1 overflow-x-auto"
                   style={{ scrollbarWidth: 'none' }}>
                {tabs.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className="text-[11px] font-mono px-3 py-1.5 border-b-2 transition-all whitespace-nowrap flex-shrink-0"
                    style={{
                      borderBottomColor: activeTab===tab.id ? color : 'transparent',
                      color: activeTab===tab.id ? color : '#6B7280',
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="p-3">
                {activeTab === 'evolucion' && <EvolucionTab pt={pt} onSave={onSave} />}
                {activeTab === 'plan'      && <PlanTab      pt={pt} onSave={onSave} />}
                {activeTab === 'qx'        && <QxTab        pt={pt} onSave={onSave} />}
                {activeTab === 'guardia'   && <GuardiaTab   pt={pt} onSave={onSave} />}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}
