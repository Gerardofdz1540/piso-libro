-- Trigger: auto-sync winlab_labs → patients.labs_history
-- Run this in Supabase SQL Editor AFTER running migrate_patients_v2.sql
-- When the RPA scraper inserts a new row into winlab_labs,
-- this trigger automatically updates the matching patient's labs_history array.

CREATE OR REPLACE FUNCTION fn_sync_labs_history()
RETURNS TRIGGER AS $$
DECLARE
  v_exp TEXT;
BEGIN
  v_exp := TRIM(NEW.exp::TEXT);
  IF v_exp = '' OR v_exp IS NULL THEN
    RETURN NEW;
  END IF;

  -- Rebuild labs_history for this patient: latest 5 winlab rows, newest first
  UPDATE patients
  SET labs_history = (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'exp',        wl.exp,
          'fecha',      wl.fecha,
          'scraped_at', wl.scraped_at,
          'headers',    wl.data -> 'headers',
          'reportes',   wl.data -> 'reportes'
        )
        ORDER BY wl.scraped_at DESC
      ),
      '[]'::jsonb
    )
    FROM (
      SELECT exp, fecha, scraped_at, data
      FROM   winlab_labs
      WHERE  TRIM(exp::TEXT) = v_exp
      ORDER  BY scraped_at DESC
      LIMIT  5
    ) wl
  )
  WHERE TRIM(exp::TEXT) = v_exp;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop existing trigger if re-running
DROP TRIGGER IF EXISTS trg_sync_labs_history ON winlab_labs;

CREATE TRIGGER trg_sync_labs_history
AFTER INSERT OR UPDATE ON winlab_labs
FOR EACH ROW EXECUTE FUNCTION fn_sync_labs_history();

-- Backfill: sync all existing winlab_labs rows into patients.labs_history right now
-- (Run once after creating the trigger)
DO $$
DECLARE
  v_exp TEXT;
BEGIN
  FOR v_exp IN (SELECT DISTINCT TRIM(exp::TEXT) FROM winlab_labs WHERE exp IS NOT NULL)
  LOOP
    UPDATE patients
    SET labs_history = (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'exp',        wl.exp,
            'fecha',      wl.fecha,
            'scraped_at', wl.scraped_at,
            'headers',    wl.data -> 'headers',
            'reportes',   wl.data -> 'reportes'
          )
          ORDER BY wl.scraped_at DESC
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT exp, fecha, scraped_at, data
        FROM   winlab_labs
        WHERE  TRIM(exp::TEXT) = v_exp
        ORDER  BY scraped_at DESC
        LIMIT  5
      ) wl
    )
    WHERE TRIM(exp::TEXT) = v_exp;
  END LOOP;
END;
$$;

SELECT 'Trigger created and backfill complete. patients.labs_history is now populated.' AS status;
