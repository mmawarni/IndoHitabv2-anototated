-- Paginated translation workspace list. Replaces client-side loading of every
-- tqa_tables/table_cells/qa_pairs row (capped at 1000 rows and slow under RLS):
-- the page is chosen first, then progress counts are computed for that page only.

BEGIN;

CREATE OR REPLACE FUNCTION public.translation_workspace_page_v10(
  _batch integer DEFAULT NULL,
  _pilot_mode text DEFAULT 'all',
  _limit integer DEFAULT 30,
  _offset integer DEFAULT 0
) RETURNS TABLE (
  table_id uuid,
  code text,
  title_en text,
  title_id text,
  batch_no integer,
  is_pilot boolean,
  header_assigned boolean,
  cells_total bigint,
  cells_done bigint,
  qa_total bigint,
  qa_done bigint,
  total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  uid uuid := auth.uid();
  is_admin boolean;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Login required' USING ERRCODE='42501'; END IF;
  IF _pilot_mode NOT IN ('all','pilot','nonpilot') THEN
    RAISE EXCEPTION 'pilot_mode must be all, pilot, or nonpilot';
  END IF;
  IF _limit IS NULL OR _limit < 1 OR _limit > 100 OR _offset IS NULL OR _offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination';
  END IF;
  is_admin := public.has_role(uid,'admin');

  RETURN QUERY
  WITH scoped AS (
    SELECT t.id, t.code, t.title_en, t.title_id, t.batch_no, COALESCE(t.is_pilot,false) AS is_pilot,
           (t.annotate_flag=1 AND (is_admin OR public.hitab_is_assigned_annotator(uid,t.annotator_id)))
             AS header_assigned
    FROM public.tqa_tables t
    WHERE (_batch IS NULL OR t.batch_no=_batch)
      AND (_pilot_mode='all' OR (_pilot_mode='pilot' AND COALESCE(t.is_pilot,false))
           OR (_pilot_mode='nonpilot' AND NOT COALESCE(t.is_pilot,false)))
  ), page AS (
    SELECT s.*, count(*) OVER ()::bigint AS total_count
    FROM scoped s
    WHERE is_admin OR s.header_assigned
       OR EXISTS (SELECT 1 FROM public.qa_pairs q
                  WHERE q.table_id=s.id AND q.annotate_flag=1
                    AND public.hitab_is_assigned_annotator(uid,q.annotator_id))
    ORDER BY s.batch_no NULLS LAST, s.code, s.id
    LIMIT _limit OFFSET _offset
  )
  SELECT p.id, p.code, p.title_en, p.title_id, p.batch_no, p.is_pilot, p.header_assigned,
         COALESCE(c.total,0), COALESCE(c.done,0), COALESCE(qa.total,0), COALESCE(qa.done,0),
         p.total_count
  FROM page p
  LEFT JOIN LATERAL (
    SELECT count(*)::bigint AS total,
           count(*) FILTER (WHERE nullif(btrim(tc.target_text),'') IS NOT NULL)::bigint AS done
    FROM public.table_cells tc
    WHERE p.header_assigned AND tc.table_id=p.id
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::bigint AS total,
           count(*) FILTER (WHERE nullif(btrim(q.question_id),'') IS NOT NULL
                              AND nullif(btrim(q.answer_id),'') IS NOT NULL)::bigint AS done
    FROM public.qa_pairs q
    WHERE q.table_id=p.id AND q.annotate_flag=1 AND (is_admin OR q.annotator_id=uid)
  ) qa ON true
  ORDER BY p.batch_no NULLS LAST, p.code, p.id;
END;
$$;
REVOKE ALL ON FUNCTION public.translation_workspace_page_v10(integer,text,integer,integer)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.translation_workspace_page_v10(integer,text,integer,integer)
  TO authenticated;

-- Batch numbers available in the caller's workspace, for the batch filter.
CREATE OR REPLACE FUNCTION public.translation_workspace_batches_v10()
RETURNS TABLE (batch_no integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT t.batch_no
  FROM public.tqa_tables t
  WHERE auth.uid() IS NOT NULL AND t.batch_no IS NOT NULL
    AND (public.has_role(auth.uid(),'admin')
      OR (t.annotate_flag=1 AND public.hitab_is_assigned_annotator(auth.uid(),t.annotator_id))
      OR EXISTS (SELECT 1 FROM public.qa_pairs q
                 WHERE q.table_id=t.id AND q.annotate_flag=1
                   AND public.hitab_is_assigned_annotator(auth.uid(),q.annotator_id)))
  ORDER BY t.batch_no;
$$;
REVOKE ALL ON FUNCTION public.translation_workspace_batches_v10() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.translation_workspace_batches_v10() TO authenticated;

COMMIT;
