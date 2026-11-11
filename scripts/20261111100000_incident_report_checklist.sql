-- Laporan Kendala: checklist + severity + open questions on incident_reports.
--
-- Annotators and validators both file reports for a table and both can read every
-- report of that table. Reports are read-only once saved and never change
-- translation/review completion status.

BEGIN;

ALTER TABLE public.incident_reports
  ADD COLUMN IF NOT EXISTS issue_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS severity text
    CHECK (severity IN ('minor','major','critical')),
  ADD COLUMN IF NOT EXISTS suggestion text,
  ADD COLUMN IF NOT EXISTS reporter_role text
    CHECK (reporter_role IN ('anotator','validator','admin'));

ALTER TABLE public.incident_reports
  DROP CONSTRAINT IF EXISTS incident_reports_issue_types_check;
ALTER TABLE public.incident_reports
  ADD CONSTRAINT incident_reports_issue_types_check CHECK (issue_types <@ ARRAY[
    'makna','istilah_tidak_konsisten','istilah_ambigu','nama_diri','struktur_header',
    'body_cell','angka_simbol_satuan','pertanyaan','jawaban','ketidaksesuaian_qa',
    'bahasa_typo','data_sumber','aplikasi','lainnya'
  ]::text[]);

-- The checklist replaces the single category; keep the column for the older form.
ALTER TABLE public.incident_reports ALTER COLUMN category SET DEFAULT 'lainnya';

-- Everyone who can open the table (its annotator, validators, admins) reads its reports.
DROP POLICY IF EXISTS incident_reports_read_own_or_admin ON public.incident_reports;
DROP POLICY IF EXISTS incident_reports_read_table_scope ON public.incident_reports;
CREATE POLICY incident_reports_read_table_scope
ON public.incident_reports FOR SELECT TO authenticated
USING (reporter_id = auth.uid() OR public.hitab_can_read_table(table_id));

-- Reporters may only file reports for tables they can open.
DROP POLICY IF EXISTS incident_reports_insert_own ON public.incident_reports;
CREATE POLICY incident_reports_insert_own
ON public.incident_reports FOR INSERT TO authenticated
WITH CHECK (reporter_id = auth.uid() AND public.hitab_can_read_table(table_id));

NOTIFY pgrst, 'reload schema';

COMMIT;
