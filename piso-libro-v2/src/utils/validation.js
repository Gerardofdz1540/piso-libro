// Specialty normalization — ported from index.html

const NON_ESP = new Set([
  'RECUPERACION', 'UCIA', 'UCIP', 'UCIPE', 'UCI', 'UCI 1', 'UCI 2',
  'TERAPIA', 'TERAPIA INTENSIVA', 'PISO', 'PISO 3', 'PISO 4',
  'PEDIATRIA', 'MEDICINA INTERNA', 'OBSTETRICIA', 'CARDIOLOGIA',
  'TRAUMA', 'URGENCIAS', 'TRAUMATOLOGIA', 'TRAUMATOLOGIA Y ORTOPEDIA',
  'HEMATOLOGIA', 'ONCOLOGIA', 'GINECOLOGIA/HEMATOLOGIA/ONCOLOGIA',
  'GINECOLOGIA / HEMATOLOGIA / ONCOLOGIA',
  'ESTABLE', 'DELICADO', 'GRAVE', 'ALTA', 'DEFUNCION', 'DEFUNCIÓN',
  'MASCULINO', 'FEMENINO', 'M', 'F',
])

const ESP_MAP = {
  'CIRUGIA GENERAL': 'CG', 'CIR GENERAL': 'CG', 'CIR GRAL': 'CG',
  'CIRUGIA GRAL': 'CG', 'CIRUGIA GEN': 'CG', 'CG': 'CG',
  'CX GENERAL': 'CG', 'CX GRAL': 'CG', 'CIRUG GRAL': 'CG',
  'C GENERAL': 'CG', 'C GRAL': 'CG', 'CG HGL': 'CG',
  'CIRUGIA GASTROINTESTINAL': 'CG', 'GASTRO QX': 'CG',
  'COLOPROCTOLOGIA': 'CCR', 'CIRUGIA COLORRECTAL': 'CCR', 'COLORRECTAL': 'CCR',
  'COLOPROCTO': 'CCR', 'PROCTO': 'CCR', 'CCR': 'CCR',
  'CIRUGIA VASCULAR': 'CV', 'CX VASCULAR': 'CV', 'VASCULAR': 'CV', 'CV': 'CV',
  'CIRUGIA PLASTICA': 'CPR', 'PLASTICA': 'CPR',
  'CIRUGIA PLASTICA Y RECONSTRUCTIVA': 'CPR', 'CX PLASTICA': 'CPR', 'CPR': 'CPR',
  'CIRUGIA DE TORAX': 'CT', 'CX DE TORAX': 'CT', 'CX TORAX': 'CT',
  'CIRUGIA TORACICA': 'CT', 'TORACICA': 'CT', 'CT': 'CT',
  'CIRUGIA TORACOVASCULAR': 'CTV', 'TORACOVASCULAR': 'CTV',
  'CARDIOTORAX': 'CTV', 'CTV': 'CTV',
  'CIRUGIA MAXILOFACIAL': 'CMF', 'MAXILOFACIAL': 'CMF', 'CMF': 'CMF',
  'UROLOGIA': 'URO', 'URO': 'URO',
  'NEUROCIRUGIA': 'NCX', 'NEURO CX': 'NCX', 'NEUROCX': 'NCX', 'NCX': 'NCX',
  'ONCOCIRUGIA': 'ONCOCIRUGÍA', 'ONCOCIRUGÍA': 'ONCOCIRUGÍA',
  'ENDOSCOPIA': 'ENDOS', 'ENDOS': 'ENDOS',
  'GINECOLOGIA Y OBSTETRICIA': 'GYO', 'GINECO OBSTETRICIA': 'GYO',
  'GINECOLOGIA': 'GYO', 'GYO': 'GYO',
  'GYO/CG': 'CG/GYO', 'CG/GYO': 'CG/GYO',
  'CG/CV': 'CG/CV', 'CV/CG': 'CG/CV',
  'TRASPLANTE Y ONCOLOGIA': 'TYO', 'TRASPLANTE': 'TYO', 'TYO': 'TYO',
  'TYO/NCX': 'TYO/NCX',
  'COLUMNA VERTEBRAL': 'COLUMNA', 'COLUMNA': 'COLUMNA',
}

function stripDiacritics(s) {
  return String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeEsp(raw) {
  const v = stripDiacritics(raw)
  if (!v || NON_ESP.has(v)) return ''
  return ESP_MAP[v] ?? v
}

export function isBedFormat(s) {
  const t = String(s ?? '').trim()
  return /^\d+\s*-\s*\d+$/.test(t) || /^[A-ZÁÉÍÓÚ]+-\d+$/i.test(t)
}

export function isExpFormat(s) {
  const t = String(s ?? '').trim()
  return /^\d{2}-\d{4,6}$/.test(t)
}

// Normalize a patient name: uppercase, no diacritics, collapse spaces
export function normalizeName(s) {
  return stripDiacritics(s).replace(/\s+/g, ' ').trim()
}

// Validate that a patient object has the minimum required fields
export function validatePatient(p) {
  const errors = []
  if (!p.nombre || String(p.nombre).trim().length < 2) errors.push('nombre requerido')
  if (!p.cama || String(p.cama).trim().length === 0) errors.push('cama requerida')
  if (!p.exp || String(p.exp).trim().length === 0) errors.push('expediente requerido')
  return errors
}
