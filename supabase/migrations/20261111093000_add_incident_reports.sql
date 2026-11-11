-- Incident reports for IndoHiTAB translation workspace.
-- Additive migration: does not modify translation/review data.

CREATE TABLE IF NOT EXISTS public.incident_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tqa_tables(id) ON DELETE CASCADE,
  qa_pair_id uuid REFERENCES public.qa_pairs(id) ON DELETE SET NULL,
  reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  category text NOT NULL CHECK (category IN ('data_sumber','terjemahan','struktur_tabel','qa','aplikasi','lainnya')),
  location_note text,
  description text NOT NULL CHECK (length(btrim(description)) >= 10),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','rejected')),
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS incident_reports_table_idx
  ON public.incident_reports(table_id, created_at DESC);
CREATE INDEX IF NOT EXISTS incident_reports_reporter_idx
  ON public.incident_reports(reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS incident_reports_status_idx
  ON public.incident_reports(status, created_at DESC);

ALTER TABLE public.incident_reports ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.incident_reports TO authenticated;
GRANT ALL ON public.incident_reports TO service_role;

DROP POLICY IF EXISTS incident_reports_insert_own ON public.incident_reports;
CREATE POLICY incident_reports_insert_own
ON public.incident_reports FOR INSERT TO authenticated
WITH CHECK (reporter_id = auth.uid());

DROP POLICY IF EXISTS incident_reports_read_own_or_admin ON public.incident_reports;
CREATE POLICY incident_reports_read_own_or_admin
ON public.incident_reports FOR SELECT TO authenticated
USING (reporter_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS incident_reports_admin_update ON public.incident_reports;
CREATE POLICY incident_reports_admin_update
ON public.incident_reports FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.hitab_incident_reports_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status = 'resolved' AND OLD.status IS DISTINCT FROM 'resolved' THEN
    NEW.resolved_at := now();
    NEW.resolved_by := auth.uid();
  ELSIF NEW.status <> 'resolved' THEN
    NEW.resolved_at := NULL;
    NEW.resolved_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hitab_incident_reports_touch_updated_at ON public.incident_reports;
CREATE TRIGGER hitab_incident_reports_touch_updated_at
BEFORE UPDATE ON public.incident_reports
FOR EACH ROW EXECUTE FUNCTION public.hitab_incident_reports_touch_updated_at();
