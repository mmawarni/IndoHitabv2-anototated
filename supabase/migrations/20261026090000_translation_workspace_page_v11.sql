-- Paginated translation workspace list (v9 table-based assignment).
--
-- The page used to select every row of table_cells and qa_pairs. Under RLS that runs
-- hitab_can_read_table()/hitab_can_read_qa() once per row, which exceeds the statement
-- timeout (57014). This function checks the caller's scope once, picks one page of
-- tables, and counts cells/QA for that page only.

BEGIN;

DROP FUNCTION IF EXISTS public.translation_workspace_page_v10(integer,text,integer,integer);
DROP FUNCTION IF EXISTS public.translation_workspace_batches_v10();

CREATE OR REPLACE FUNCTION public.translation_workspace_page_v11(
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
  WITH page AS (
    SELECT t.id, t.code, t.title_en, t.title_id, t.batch_no, COALESCE(t.is_pilot,false) AS is_pilot,
           count(*) OVER ()::bigint AS total_count
    FROM public.tqa_tables t
    WHERE t.annotate_flag=1
      AND (is_admin OR t.annotator_id=uid
           -- Backward compatibility: before v9 some QA was assigned separately.
           OR EXISTS (SELECT 1 FROM public.qa_pairs q
                      WHERE q.table_id=t.id AND q.annotate_flag=1 AND q.annotator_id=uid))
      AND (_batch IS NULL OR t.batch_no=_batch)
      AND (_pilot_mode='all' OR (_pilot_mode='pilot' AND COALESCE(t.is_pilot,false))
           OR (_pilot_mode='nonpilot' AND NOT COALESCE(t.is_pilot,false)))
    ORDER BY t.batch_no NULLS LAST, t.code, t.id
    LIMIT _limit OFFSET _offset
  )
  SELECT p.id, p.code, p.title_en, p.title_id, p.batch_no, p.is_pilot,
         c.total, c.done, qa.total, qa.done, p.total_count
  FROM page p
  CROSS JOIN LATERAL (
    SELECT count(*)::bigint AS total,
           count(*) FILTER (WHERE nullif(btrim(tc.target_text),'') IS NOT NULL)::bigint AS done
    FROM public.table_cells tc
    WHERE tc.table_id=p.id
  ) c
  -- v9: every sampled QA of the table counts; QA assignment follows the table.
  CROSS JOIN LATERAL (
    SELECT count(*)::bigint AS total,
           count(*) FILTER (WHERE nullif(btrim(q.question_id),'') IS NOT NULL
                              AND nullif(btrim(q.answer_id),'') IS NOT NULL)::bigint AS done
    FROM public.qa_pairs q
    WHERE q.table_id=p.id AND q.annotate_flag=1
  ) qa
  ORDER BY p.batch_no NULLS LAST, p.code, p.id;
END;
$$;
REVOKE ALL ON FUNCTION public.translation_workspace_page_v11(integer,text,integer,integer)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.translation_workspace_page_v11(integer,text,integer,integer)
  TO authenticated;

-- Batch numbers available in the caller's workspace, for the batch filter.
CREATE OR REPLACE FUNCTION public.translation_workspace_batches_v11()
RETURNS TABLE (batch_no integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT t.batch_no
  FROM public.tqa_tables t
  WHERE auth.uid() IS NOT NULL AND t.annotate_flag=1 AND t.batch_no IS NOT NULL
    AND (public.has_role(auth.uid(),'admin') OR t.annotator_id=auth.uid()
      OR EXISTS (SELECT 1 FROM public.qa_pairs q
                 WHERE q.table_id=t.id AND q.annotate_flag=1 AND q.annotator_id=auth.uid()))
  ORDER BY t.batch_no;
$$;
REVOKE ALL ON FUNCTION public.translation_workspace_batches_v11() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.translation_workspace_batches_v11() TO authenticated;

CREATE INDEX IF NOT EXISTS hitab_tables_annotator_idx ON public.tqa_tables(annotator_id) WHERE annotate_flag=1;

COMMIT;
