-- Translation workspace list (terjemahan index): per-table progress in one call.
--
-- The page selected every table_cells and qa_pairs row; under RLS each row runs
-- hitab_can_read_table()/hitab_can_read_qa(), which hits the statement timeout (57014)
-- and the 1000-row cap. This returns one row per table in the caller's workspace.
--
-- "Done" follows hitab_dashboard_breakdown_v8 so the list and the dashboard agree:
--   table translated = title_id filled + at least one cell + every cell filled
--   QA translated    = status 'selesai' + question_id + answer_id filled
--   validated        = table_reviews.status 'selesai' + validated_table present

BEGIN;

CREATE OR REPLACE FUNCTION public.hitab_translation_workspace_v14()
RETURNS TABLE (
  id uuid,
  code text,
  title_en text,
  title_id text,
  batch_no integer,
  is_pilot boolean,
  validated boolean,
  cells_total bigint,
  cells_done bigint,
  body_cells_remaining bigint,
  non_body_cells_remaining bigint,
  qa_total bigint,
  qa_done bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  uid uuid := auth.uid();
  is_admin boolean;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Login required' USING ERRCODE='42501'; END IF;
  is_admin := public.has_role(uid,'admin');

  RETURN QUERY
  WITH scoped AS (
    SELECT t.id, t.code, t.title_en, t.title_id, t.batch_no,
           COALESCE(t.is_pilot,false) AS is_pilot,
           (tr.status='selesai' AND t.validated_table IS NOT NULL) AS validated
    FROM public.tqa_tables t
    LEFT JOIN public.table_reviews tr ON tr.table_id=t.id
    WHERE t.annotate_flag=1
      AND (is_admin OR t.annotator_id=uid
           -- Backward compatibility: before v9 some QA was assigned separately.
           OR EXISTS (SELECT 1 FROM public.qa_pairs q
                      WHERE q.table_id=t.id AND q.annotate_flag=1 AND q.annotator_id=uid))
  ), cell_stats AS (
    SELECT tc.table_id, count(*)::bigint AS total,
           count(*) FILTER (WHERE nullif(btrim(tc.target_text),'') IS NOT NULL)::bigint AS done,
           count(*) FILTER (WHERE tc.is_body_text IS TRUE
                              AND nullif(btrim(tc.target_text),'') IS NULL)::bigint AS body_left,
           count(*) FILTER (WHERE tc.is_body_text IS NOT TRUE
                              AND nullif(btrim(tc.target_text),'') IS NULL)::bigint AS non_body_left
    FROM public.table_cells tc JOIN scoped s ON s.id=tc.table_id
    GROUP BY tc.table_id
  ), qa_stats AS (
    SELECT q.table_id, count(*)::bigint AS total,
           count(*) FILTER (WHERE q.status='selesai'
                              AND nullif(btrim(q.question_id),'') IS NOT NULL
                              AND nullif(btrim(q.answer_id),'') IS NOT NULL)::bigint AS done
    FROM public.qa_pairs q JOIN scoped s ON s.id=q.table_id
    WHERE q.annotate_flag=1
    GROUP BY q.table_id
  )
  SELECT s.id, s.code, s.title_en, s.title_id, s.batch_no, s.is_pilot, COALESCE(s.validated,false),
         COALESCE(c.total,0), COALESCE(c.done,0), COALESCE(c.body_left,0), COALESCE(c.non_body_left,0),
         COALESCE(qs.total,0), COALESCE(qs.done,0)
  FROM scoped s
  LEFT JOIN cell_stats c ON c.table_id=s.id
  LEFT JOIN qa_stats qs ON qs.table_id=s.id
  ORDER BY s.batch_no NULLS LAST, s.code, s.id;
END;
$$;
REVOKE ALL ON FUNCTION public.hitab_translation_workspace_v14() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hitab_translation_workspace_v14() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
