-- Translation workspace: add a done / not-done filter.
--
-- A table is done when its title, every header/column cell and every sampled QA pair
-- (question and answer) are translated. The status must be known before LIMIT/OFFSET,
-- so progress is aggregated for every table in the caller's scope, then paginated.

BEGIN;

DROP FUNCTION IF EXISTS public.translation_workspace_page_v11(integer,text,integer,integer);

CREATE OR REPLACE FUNCTION public.translation_workspace_page_v12(
  _batch integer DEFAULT NULL,
  _pilot_mode text DEFAULT 'all',
  _status text DEFAULT 'all',
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
  is_done boolean,
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
  IF _status NOT IN ('all','done','notdone') THEN
    RAISE EXCEPTION 'status must be all, done, or notdone';
  END IF;
  IF _limit IS NULL OR _limit < 1 OR _limit > 100 OR _offset IS NULL OR _offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination';
  END IF;
  is_admin := public.has_role(uid,'admin');

  RETURN QUERY
  WITH scoped AS (
    SELECT t.id, t.code, t.title_en, t.title_id, t.batch_no, COALESCE(t.is_pilot,false) AS is_pilot
    FROM public.tqa_tables t
    WHERE t.annotate_flag=1
      AND (is_admin OR t.annotator_id=uid
           -- Backward compatibility: before v9 some QA was assigned separately.
           OR EXISTS (SELECT 1 FROM public.qa_pairs q
                      WHERE q.table_id=t.id AND q.annotate_flag=1 AND q.annotator_id=uid))
      AND (_batch IS NULL OR t.batch_no=_batch)
      AND (_pilot_mode='all' OR (_pilot_mode='pilot' AND COALESCE(t.is_pilot,false))
           OR (_pilot_mode='nonpilot' AND NOT COALESCE(t.is_pilot,false)))
  ), cell_stats AS (
    SELECT tc.table_id AS id, count(*)::bigint AS total,
           count(*) FILTER (WHERE nullif(btrim(tc.target_text),'') IS NOT NULL)::bigint AS done
    FROM public.table_cells tc JOIN scoped s ON s.id=tc.table_id
    GROUP BY tc.table_id
  ), qa_stats AS (
    -- v9: every sampled QA of the table counts; QA assignment follows the table.
    SELECT q.table_id AS id, count(*)::bigint AS total,
           count(*) FILTER (WHERE nullif(btrim(q.question_id),'') IS NOT NULL
                              AND nullif(btrim(q.answer_id),'') IS NOT NULL)::bigint AS done
    FROM public.qa_pairs q JOIN scoped s ON s.id=q.table_id
    WHERE q.annotate_flag=1
    GROUP BY q.table_id
  ), progress AS (
    SELECT s.*,
           COALESCE(c.total,0) AS cells_total, COALESCE(c.done,0) AS cells_done,
           COALESCE(qs.total,0) AS qa_total, COALESCE(qs.done,0) AS qa_done,
           (nullif(btrim(s.title_id),'') IS NOT NULL
             AND COALESCE(c.done,0)=COALESCE(c.total,0)
             AND COALESCE(qs.done,0)=COALESCE(qs.total,0)) AS is_done
    FROM scoped s
    LEFT JOIN cell_stats c ON c.id=s.id
    LEFT JOIN qa_stats qs ON qs.id=s.id
  )
  SELECT p.id, p.code, p.title_en, p.title_id, p.batch_no, p.is_pilot,
         p.cells_total, p.cells_done, p.qa_total, p.qa_done, p.is_done,
         count(*) OVER ()::bigint
  FROM progress p
  WHERE _status='all' OR (_status='done' AND p.is_done) OR (_status='notdone' AND NOT p.is_done)
  ORDER BY p.batch_no NULLS LAST, p.code, p.id
  LIMIT _limit OFFSET _offset;
END;
$$;
REVOKE ALL ON FUNCTION public.translation_workspace_page_v12(integer,text,text,integer,integer)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.translation_workspace_page_v12(integer,text,text,integer,integer)
  TO authenticated;

COMMIT;
