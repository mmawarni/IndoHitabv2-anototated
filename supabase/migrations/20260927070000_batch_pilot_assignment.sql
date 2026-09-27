-- IndoHiTAB v9: table-only assignment, provided batches, and pilot flag.
-- Prerequisite: migrations through v7.1 (admin_assign_tables_with_qa must exist).
-- Safe/additive: does not delete dataset rows or user accounts.
BEGIN;

ALTER TABLE public.tqa_tables
  ADD COLUMN IF NOT EXISTS batch_no integer CHECK (batch_no IS NULL OR batch_no > 0),
  ADD COLUMN IF NOT EXISTS is_pilot boolean NOT NULL DEFAULT false;

ALTER TABLE public.qa_pairs
  ADD COLUMN IF NOT EXISTS batch_no integer CHECK (batch_no IS NULL OR batch_no > 0),
  ADD COLUMN IF NOT EXISTS is_pilot boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS hitab_table_batch_idx
  ON public.tqa_tables(batch_no, is_pilot, annotate_flag);
CREATE INDEX IF NOT EXISTS hitab_qa_batch_idx
  ON public.qa_pairs(batch_no, is_pilot, annotate_flag, table_id);

-- QA always inherits batch/pilot metadata from its parent table.
CREATE OR REPLACE FUNCTION public.hitab_sync_qa_batch_pilot()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE parent_batch integer; parent_pilot boolean;
BEGIN
  SELECT t.batch_no, t.is_pilot INTO parent_batch, parent_pilot
  FROM public.tqa_tables t WHERE t.id = NEW.table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Parent table not found for QA %', NEW.id;
  END IF;
  NEW.batch_no := parent_batch;
  NEW.is_pilot := parent_pilot;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hitab_qa_batch_pilot_sync ON public.qa_pairs;
CREATE TRIGGER hitab_qa_batch_pilot_sync
BEFORE INSERT OR UPDATE OF table_id, batch_no, is_pilot ON public.qa_pairs
FOR EACH ROW EXECUTE FUNCTION public.hitab_sync_qa_batch_pilot();

-- If an Admin later changes table metadata, keep all QA aligned.
CREATE OR REPLACE FUNCTION public.hitab_cascade_table_batch_pilot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.batch_no IS DISTINCT FROM OLD.batch_no OR NEW.is_pilot IS DISTINCT FROM OLD.is_pilot THEN
    UPDATE public.qa_pairs
      SET batch_no = NEW.batch_no, is_pilot = NEW.is_pilot
      WHERE table_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hitab_table_batch_pilot_cascade ON public.tqa_tables;
CREATE TRIGGER hitab_table_batch_pilot_cascade
AFTER UPDATE OF batch_no, is_pilot ON public.tqa_tables
FOR EACH ROW EXECUTE FUNCTION public.hitab_cascade_table_batch_pilot();

-- Protect research design metadata from annotator-side direct API updates.
CREATE OR REPLACE FUNCTION public.hitab_batch_pilot_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.batch_no IS DISTINCT FROM OLD.batch_no OR NEW.is_pilot IS DISTINCT FROM OLD.is_pilot)
     AND current_user NOT IN ('postgres','service_role')
     AND NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'Only Admin may change batch/pilot metadata' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hitab_table_batch_pilot_guard ON public.tqa_tables;
CREATE TRIGGER hitab_table_batch_pilot_guard
BEFORE UPDATE OF batch_no, is_pilot ON public.tqa_tables
FOR EACH ROW EXECUTE FUNCTION public.hitab_batch_pilot_guard();

DROP TRIGGER IF EXISTS hitab_qa_batch_pilot_guard ON public.qa_pairs;
CREATE TRIGGER hitab_qa_batch_pilot_guard
BEFORE UPDATE OF batch_no, is_pilot ON public.qa_pairs
FOR EACH ROW EXECUTE FUNCTION public.hitab_batch_pilot_guard();

-- Admin-only queue. Assignment is now TABLE-ONLY; QA is never assigned independently.
CREATE OR REPLACE FUNCTION public.table_assignment_queue_v9(
  _search text DEFAULT '',
  _batch integer DEFAULT NULL,
  _pilot_mode text DEFAULT 'all',
  _limit integer DEFAULT 30,
  _offset integer DEFAULT 0
) RETURNS TABLE (
  item_id uuid,
  source_id text,
  table_code text,
  source_text text,
  annotate_flag integer,
  annotator_id uuid,
  validator_id uuid,
  batch_no integer,
  is_pilot boolean,
  qa_count bigint,
  total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE='42501';
  END IF;
  IF _pilot_mode NOT IN ('all','pilot','nonpilot') THEN
    RAISE EXCEPTION 'pilot_mode must be all, pilot, or nonpilot';
  END IF;
  IF _limit IS NULL OR _limit < 1 OR _limit > 100 OR _offset IS NULL OR _offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination';
  END IF;

  RETURN QUERY
  SELECT t.id, t.original_table_id, t.code, t.title_en, t.annotate_flag,
         t.annotator_id, t.validator_id, t.batch_no, t.is_pilot,
         count(q.id) FILTER (WHERE q.annotate_flag=1)::bigint AS qa_count,
         count(*) OVER ()::bigint AS total_count
  FROM public.tqa_tables t
  LEFT JOIN public.qa_pairs q ON q.table_id=t.id
  WHERE t.original_table_id IS NOT NULL
    AND (_batch IS NULL OR t.batch_no=_batch)
    AND (_pilot_mode='all' OR (_pilot_mode='pilot' AND t.is_pilot)
         OR (_pilot_mode='nonpilot' AND NOT t.is_pilot))
    AND (COALESCE(_search,'')='' OR t.original_table_id ILIKE '%'||_search||'%'
         OR t.code ILIKE '%'||_search||'%' OR t.title_en ILIKE '%'||_search||'%')
  GROUP BY t.id,t.original_table_id,t.code,t.title_en,t.annotate_flag,
           t.annotator_id,t.validator_id,t.batch_no,t.is_pilot
  ORDER BY t.batch_no NULLS LAST,t.is_pilot DESC,t.original_table_id,t.id
  LIMIT _limit OFFSET _offset;
END;
$$;
REVOKE ALL ON FUNCTION public.table_assignment_queue_v9(text,integer,text,integer,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.table_assignment_queue_v9(text,integer,text,integer,integer)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.assignment_batch_summary_v9()
RETURNS TABLE (
  batch_no integer,
  tables bigint,
  qa bigint,
  pilot_tables bigint,
  pilot_qa bigint,
  assigned_tables bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT t.batch_no,
         count(DISTINCT t.id)::bigint AS tables,
         count(q.id) FILTER (WHERE q.annotate_flag=1)::bigint AS qa,
         count(DISTINCT t.id) FILTER (WHERE t.is_pilot)::bigint AS pilot_tables,
         count(q.id) FILTER (WHERE q.annotate_flag=1 AND t.is_pilot)::bigint AS pilot_qa,
         count(DISTINCT t.id) FILTER (WHERE t.annotator_id IS NOT NULL OR t.validator_id IS NOT NULL)::bigint
  FROM public.tqa_tables t
  LEFT JOIN public.qa_pairs q ON q.table_id=t.id
  WHERE t.batch_no IS NOT NULL AND t.annotate_flag=1
  GROUP BY t.batch_no
  ORDER BY t.batch_no;
END;
$$;
REVOKE ALL ON FUNCTION public.assignment_batch_summary_v9() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.assignment_batch_summary_v9() TO authenticated;

-- Assign a whole provided batch. Internally chunk at <=100 tables because the
-- existing bulk-assignment RPC intentionally caps one call at 100 IDs.
-- Any error still rolls the whole RPC back as one database transaction.
CREATE OR REPLACE FUNCTION public.admin_assign_batch_with_qa(
  _batch integer,
  _annotator_id uuid DEFAULT NULL,
  _validator_id uuid DEFAULT NULL,
  _change_annotator boolean DEFAULT true,
  _change_validator boolean DEFAULT true,
  _pilot_mode text DEFAULT 'all'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  source_ids text[];
  chunk text[];
  start_idx integer := 1;
  total integer;
  last_idx integer;
  part jsonb;
  tables_done integer := 0;
  qa_done integer := 0;
  qa_skipped integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE='42501';
  END IF;
  IF _batch IS NULL OR _batch < 1 THEN RAISE EXCEPTION 'Invalid batch'; END IF;
  IF _pilot_mode NOT IN ('all','pilot','nonpilot') THEN
    RAISE EXCEPTION 'pilot_mode must be all, pilot, or nonpilot';
  END IF;
  IF NOT COALESCE(_change_annotator,false) AND NOT COALESCE(_change_validator,false) THEN
    RAISE EXCEPTION 'Choose at least one assignment field to change';
  END IF;

  SELECT array_agg(t.original_table_id ORDER BY t.original_table_id)
    INTO source_ids
  FROM public.tqa_tables t
  WHERE t.batch_no=_batch AND t.annotate_flag=1
    AND t.original_table_id IS NOT NULL
    AND (_pilot_mode='all' OR (_pilot_mode='pilot' AND t.is_pilot)
         OR (_pilot_mode='nonpilot' AND NOT t.is_pilot));

  total := COALESCE(cardinality(source_ids),0);
  IF total=0 THEN RAISE EXCEPTION 'No sampled tables found in batch % for mode %',_batch,_pilot_mode; END IF;

  WHILE start_idx <= total LOOP
    last_idx := LEAST(start_idx+99,total);
    chunk := source_ids[start_idx:last_idx];
    part := public.admin_assign_tables_with_qa(
      chunk,_annotator_id,_validator_id,_change_annotator,_change_validator
    );
    tables_done := tables_done + COALESCE((part->>'tables_assigned')::integer,0);
    qa_done := qa_done + COALESCE((part->>'qa_assigned')::integer,0);
    qa_skipped := qa_skipped + COALESCE((part->>'qa_excluded_by_sampling')::integer,0);
    start_idx := last_idx+1;
  END LOOP;

  RETURN jsonb_build_object(
    'batch',_batch,
    'pilot_mode',_pilot_mode,
    'tables_assigned',tables_done,
    'qa_assigned',qa_done,
    'qa_excluded_by_sampling',qa_skipped
  );
END;
$$;
REVOKE ALL ON FUNCTION public.admin_assign_batch_with_qa(integer,uuid,uuid,boolean,boolean,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_batch_with_qa(integer,uuid,uuid,boolean,boolean,text)
  TO authenticated;

COMMIT;
