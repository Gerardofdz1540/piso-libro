-- Migration: add v2 columns to patients table
-- Run once in Supabase SQL Editor
-- Safe to re-run (uses IF NOT EXISTS / ALTER COLUMN won't fail on existing columns)

-- ── Boolean flags ──────────────────────────────────────────────────────────────
ALTER TABLE patients ADD COLUMN IF NOT EXISTS nota_hecha boolean DEFAULT false;

-- ── Labs history (JSONB array injected by winlab scraper) ─────────────────────
ALTER TABLE patients ADD COLUMN IF NOT EXISTS labs_history jsonb DEFAULT '[]'::jsonb;

-- ── Surgical procedure fields ─────────────────────────────────────────────────
ALTER TABLE patients ADD COLUMN IF NOT EXISTS qx_date          text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS qx_procedimiento text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS qx_hallazgos     text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS qx_sangrado      text;

-- ── Vitals (stored as text to allow ranges, e.g. "120/80") ───────────────────
ALTER TABLE patients ADD COLUMN IF NOT EXISTS fc     text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS fr     text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS ta     text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS temp   text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS sao2   text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS uresis text;

-- ── Clinical plan fields (flat on patients, not in notes) ─────────────────────
ALTER TABLE patients ADD COLUMN IF NOT EXISTS dieta     text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS atb       text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS tvp       text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS npt       text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS balance   text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS manejo    text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS pendientes text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS misc      text;

-- ── SOAP fields ───────────────────────────────────────────────────────────────
ALTER TABLE patients ADD COLUMN IF NOT EXISTS app      text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS pa       text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS sv       text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS drenajes text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS sangrado text;

-- ── Shift / guardia fields ────────────────────────────────────────────────────
ALTER TABLE patients ADD COLUMN IF NOT EXISTS tareas_mip      text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS tareas_r1       text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS guardia_recibes text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS guardia_entrega text;

-- ── Administrative metadata ───────────────────────────────────────────────────
ALTER TABLE patients ADD COLUMN IF NOT EXISTS r_cargo  text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS adscrito text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS estado   text DEFAULT 'activo';

-- ── Index for common query patterns ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS patients_cama_idx ON patients (cama);
CREATE INDEX IF NOT EXISTS patients_esp_idx  ON patients (esp);
CREATE INDEX IF NOT EXISTS patients_exp_idx  ON patients (exp);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'patients'
ORDER BY ordinal_position;
