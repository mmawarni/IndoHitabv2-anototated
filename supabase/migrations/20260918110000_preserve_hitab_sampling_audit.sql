-- IndoHiTAB v3: additive upgrade; run AFTER 20260918090000_add_validator_reviews.sql.
-- Back up production first. Original JSON is write-once; it is NEVER inferred from translated rows.
-- Public API must never accept a service-role key. Existing records without original JSON remain NULL.
BEGIN;

ALTER TABLE public.tqa_tables
  ADD COLUMN IF NOT EXISTS original_table_id text,
  ADD COLUMN IF NOT EXISTS original_table jsonb,
  ADD COLUMN IF NOT EXISTS annotated_table jsonb,
  ADD COLUMN IF NOT EXISTS validated_table jsonb,
  ADD COLUMN IF NOT EXISTS annotate_flag integer NOT NULL DEFAULT 1 CHECK (annotate_flag IN (0,1));
ALTER TABLE public.qa_pairs
  ADD COLUMN IF NOT EXISTS original_question_id text,
  ADD COLUMN IF NOT EXISTS original_qa jsonb,
  ADD COLUMN IF NOT EXISTS annotated_qa jsonb,
  ADD COLUMN IF NOT EXISTS validated_qa jsonb,
  ADD COLUMN IF NOT EXISTS dataset_split text CHECK (dataset_split IS NULL OR dataset_split IN ('train','dev','test')),
  ADD COLUMN IF NOT EXISTS annotate_flag integer NOT NULL DEFAULT 1 CHECK (annotate_flag IN (0,1));
ALTER TABLE public.qa_reviews ADD COLUMN IF NOT EXISTS logic_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE public.table_cells
  ADD COLUMN IF NOT EXISTS row_index integer CHECK (row_index IS NULL OR row_index >= 0),
  ADD COLUMN IF NOT EXISTS column_index integer CHECK (column_index IS NULL OR column_index >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS hitab_original_table_id_uq ON public.tqa_tables(original_table_id) WHERE original_table_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hitab_original_question_id_uq ON public.qa_pairs(original_question_id) WHERE original_question_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hitab_cell_coordinate_uq ON public.table_cells(table_id,row_index,column_index)
  WHERE row_index IS NOT NULL AND column_index IS NOT NULL;
CREATE INDEX IF NOT EXISTS hitab_table_sampling_idx ON public.tqa_tables(annotate_flag);
CREATE INDEX IF NOT EXISTS hitab_qa_sampling_idx ON public.qa_pairs(annotate_flag,table_id);

-- Write-once source: setting a missing original is allowed only for service_role, not user-facing UI.
CREATE FUNCTION public.hitab_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'tqa_tables' THEN
    IF OLD.original_table IS NOT NULL AND NEW.original_table IS DISTINCT FROM OLD.original_table THEN
      RAISE EXCEPTION 'original_table is immutable';
    END IF;
    IF OLD.original_table_id IS NOT NULL AND NEW.original_table_id IS DISTINCT FROM OLD.original_table_id THEN
      RAISE EXCEPTION 'original_table_id is immutable';
    END IF;
    IF OLD.code IS DISTINCT FROM NEW.code OR OLD.title_en IS DISTINCT FROM NEW.title_en THEN
      RAISE EXCEPTION 'Original table identity/title is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'qa_pairs' THEN
    IF OLD.original_qa IS NOT NULL AND NEW.original_qa IS DISTINCT FROM OLD.original_qa THEN
      RAISE EXCEPTION 'original_qa is immutable';
    END IF;
    IF OLD.original_question_id IS NOT NULL AND NEW.original_question_id IS DISTINCT FROM OLD.original_question_id THEN
      RAISE EXCEPTION 'original_question_id is immutable';
    END IF;
    IF OLD.question_en IS DISTINCT FROM NEW.question_en OR OLD.answer_en IS DISTINCT FROM NEW.answer_en
       OR OLD.table_id IS DISTINCT FROM NEW.table_id THEN
      RAISE EXCEPTION 'Original QA data is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'table_cells' THEN
    IF OLD.source_text IS DISTINCT FROM NEW.source_text OR OLD.table_id IS DISTINCT FROM NEW.table_id
       OR OLD.row_index IS DISTINCT FROM NEW.row_index OR OLD.column_index IS DISTINCT FROM NEW.column_index
       OR OLD.position IS DISTINCT FROM NEW.position OR OLD.kind IS DISTINCT FROM NEW.kind THEN
      RAISE EXCEPTION 'Source cell data is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hitab_table_source_immutable BEFORE UPDATE ON public.tqa_tables
 FOR EACH ROW EXECUTE FUNCTION public.hitab_source_guard();
CREATE TRIGGER hitab_qa_source_immutable BEFORE UPDATE ON public.qa_pairs
 FOR EACH ROW EXECUTE FUNCTION public.hitab_source_guard();
CREATE TRIGGER hitab_cell_source_immutable BEFORE UPDATE ON public.table_cells
 FOR EACH ROW EXECUTE FUNCTION public.hitab_source_guard();

-- Translation fields, timestamps, actor identity are enforced inside DB.
CREATE FUNCTION public.hitab_translation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'qa_pairs' THEN
    NEW.status := CASE WHEN nullif(btrim(NEW.question_id),'') IS NOT NULL
                   AND nullif(btrim(NEW.answer_id),'') IS NOT NULL THEN 'selesai' ELSE 'draft' END;
  ELSE
    NEW.status := CASE WHEN nullif(btrim(NEW.target_text),'') IS NOT NULL THEN 'selesai' ELSE 'draft' END;
  END IF;
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER hitab_cell_translation_guard BEFORE UPDATE OF target_text ON public.table_cells
 FOR EACH ROW WHEN (OLD.target_text IS DISTINCT FROM NEW.target_text)
 EXECUTE FUNCTION public.hitab_translation_guard();
CREATE TRIGGER hitab_qa_translation_guard BEFORE UPDATE OF question_id,answer_id ON public.qa_pairs
 FOR EACH ROW WHEN (OLD.question_id IS DISTINCT FROM NEW.question_id OR OLD.answer_id IS DISTINCT FROM NEW.answer_id)
 EXECUTE FUNCTION public.hitab_translation_guard();

-- Build translated table from frozen source matrix, replacing only *mapped* coordinates.
-- Never infer coordinates from the legacy position field.
CREATE FUNCTION public.hitab_refresh_annotated_table(_table_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE src jsonb; translated jsonb; c record; title_text text;
BEGIN
  SELECT original_table, title_id INTO src,title_text FROM public.tqa_tables WHERE id=_table_id FOR UPDATE;
  IF src IS NULL THEN RETURN; END IF;
  translated := src;
  IF nullif(btrim(title_text),'') IS NOT NULL THEN
    translated := jsonb_set(translated,'{title}',to_jsonb(title_text),true);
  END IF;
  IF jsonb_typeof(src->'texts') = 'array' THEN
    FOR c IN SELECT row_index,column_index,target_text FROM public.table_cells
             WHERE table_id=_table_id AND row_index IS NOT NULL AND column_index IS NOT NULL
               AND nullif(btrim(target_text),'') IS NOT NULL ORDER BY row_index,column_index LOOP
      IF c.row_index < jsonb_array_length(src->'texts')
         AND jsonb_typeof(src->'texts'->c.row_index)='array'
         AND c.column_index < jsonb_array_length(src->'texts'->c.row_index) THEN
        translated := jsonb_set(translated,ARRAY['texts',c.row_index::text,c.column_index::text],to_jsonb(c.target_text),false);
      END IF;
    END LOOP;
  END IF;
  UPDATE public.tqa_tables SET annotated_table=translated WHERE id=_table_id
    AND annotated_table IS DISTINCT FROM translated;
END;
$$;
CREATE FUNCTION public.hitab_refresh_annotated_table_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'tqa_tables' THEN
    PERFORM public.hitab_refresh_annotated_table(NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.hitab_refresh_annotated_table(OLD.table_id);
  ELSE
    PERFORM public.hitab_refresh_annotated_table(NEW.table_id);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hitab_table_translation_snapshot AFTER UPDATE OF title_id,original_table ON public.tqa_tables
 FOR EACH ROW WHEN (OLD.title_id IS DISTINCT FROM NEW.title_id OR OLD.original_table IS DISTINCT FROM NEW.original_table)
 EXECUTE FUNCTION public.hitab_refresh_annotated_table_trigger();
-- Statement-level refresh: one rebuild per table, even when one save updates 200 cells.
CREATE FUNCTION public.hitab_refresh_cell_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t record;
BEGIN
  FOR t IN SELECT DISTINCT n.table_id FROM new_cells n JOIN old_cells o ON o.id=n.id
           WHERE n.target_text IS DISTINCT FROM o.target_text LOOP
    PERFORM public.hitab_refresh_annotated_table(t.table_id);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER hitab_cell_translation_snapshot AFTER UPDATE ON public.table_cells
 REFERENCING OLD TABLE AS old_cells NEW TABLE AS new_cells
 FOR EACH STATEMENT EXECUTE FUNCTION public.hitab_refresh_cell_batch();
CREATE TRIGGER hitab_deleted_cell_translation_snapshot AFTER DELETE ON public.table_cells
 FOR EACH ROW EXECUTE FUNCTION public.hitab_refresh_annotated_table_trigger();

CREATE TRIGGER hitab_cell_imported_translation_snapshot AFTER INSERT ON public.table_cells
 FOR EACH ROW WHEN (NEW.target_text IS NOT NULL)
 EXECUTE FUNCTION public.hitab_refresh_annotated_table_trigger();

CREATE FUNCTION public.hitab_refresh_annotated_qa_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE snapshot jsonb;
BEGIN
  IF NEW.original_qa IS NULL THEN RETURN NEW; END IF;
  snapshot := NEW.original_qa || jsonb_build_object(
    'question_id',NEW.question_id,'answer_id',NEW.answer_id);
  -- The original 'answer', aggregation, formulas and linked_cells stay unchanged.
  UPDATE public.qa_pairs SET annotated_qa=snapshot WHERE id=NEW.id
    AND annotated_qa IS DISTINCT FROM snapshot;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hitab_qa_translation_snapshot AFTER INSERT OR UPDATE OF original_qa,question_id,answer_id ON public.qa_pairs
 FOR EACH ROW EXECUTE FUNCTION public.hitab_refresh_annotated_qa_trigger();

-- Validator final snapshot, never overwritten by the annotator's editable draft.
CREATE FUNCTION public.hitab_review_snapshot_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE snap jsonb; c record;
BEGIN
  IF TG_TABLE_NAME = 'table_reviews' THEN
    IF NEW.status <> 'selesai' THEN
      UPDATE public.tqa_tables SET validated_table=NULL WHERE id=NEW.table_id;
      RETURN NEW;
    END IF;
    SELECT annotated_table INTO snap FROM public.tqa_tables WHERE id=NEW.table_id;
    IF snap IS NULL THEN RETURN NEW; END IF;
    snap := jsonb_set(snap,'{title}',to_jsonb(NEW.reviewed_title_id),true);
    FOR c IN SELECT row_index,column_index, NEW.corrected_cells ->> id::text AS value
             FROM public.table_cells WHERE table_id=NEW.table_id
               AND row_index IS NOT NULL AND column_index IS NOT NULL LOOP
      IF c.value IS NOT NULL AND jsonb_typeof(snap->'texts')='array' AND c.row_index < jsonb_array_length(snap->'texts')
         AND jsonb_typeof(snap->'texts'->c.row_index)='array'
         AND c.column_index < jsonb_array_length(snap->'texts'->c.row_index) THEN
        snap := jsonb_set(snap,ARRAY['texts',c.row_index::text,c.column_index::text],to_jsonb(c.value),false);
      END IF;
    END LOOP;
    UPDATE public.tqa_tables SET validated_table=snap WHERE id=NEW.table_id;
  ELSE
    IF NEW.status <> 'selesai' THEN
      UPDATE public.qa_pairs SET validated_qa=NULL WHERE id=NEW.qa_pair_id;
      RETURN NEW;
    END IF;
    SELECT annotated_qa INTO snap FROM public.qa_pairs WHERE id=NEW.qa_pair_id;
    IF snap IS NULL THEN RETURN NEW; END IF;
    snap := snap || jsonb_build_object('question_id',NEW.reviewed_question_id,'answer_id',NEW.reviewed_answer_id);
    UPDATE public.qa_pairs SET validated_qa=snap WHERE id=NEW.qa_pair_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hitab_table_review_snapshot AFTER INSERT OR UPDATE OF status,reviewed_title_id,corrected_cells ON public.table_reviews
 FOR EACH ROW EXECUTE FUNCTION public.hitab_review_snapshot_trigger();
CREATE TRIGGER hitab_qa_review_snapshot AFTER INSERT OR UPDATE OF status,reviewed_question_id,reviewed_answer_id,logic_confirmed ON public.qa_reviews
 FOR EACH ROW EXECUTE FUNCTION public.hitab_review_snapshot_trigger();

-- Audit: immutable append-only history with server-derived actor, before and after.
CREATE TABLE public.user_work_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid, -- Keep pseudonymous provenance if an auth account is later deleted.
  actor_role text NOT NULL CHECK (actor_role IN ('anotator','validator','admin','system')),
  item_type text NOT NULL CHECK (item_type IN ('table','cell','qa','table_review','qa_review')),
  table_id uuid REFERENCES public.tqa_tables(id) ON DELETE SET NULL,
  qa_pair_id uuid REFERENCES public.qa_pairs(id) ON DELETE SET NULL,
  cell_id uuid REFERENCES public.table_cells(id) ON DELETE SET NULL,
  source_table_id text,
  source_question_id text,
  action text NOT NULL CHECK (action IN ('opened','created','saved','completed','reopened')),
  before_value jsonb,
  after_value jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hitab_work_actor_time_idx ON public.user_work_log(actor_id,occurred_at DESC);
CREATE INDEX hitab_work_table_time_idx ON public.user_work_log(table_id,occurred_at DESC);
CREATE INDEX hitab_work_qa_time_idx ON public.user_work_log(qa_pair_id,occurred_at DESC);
ALTER TABLE public.user_work_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_work_log FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.user_work_log TO authenticated;
GRANT ALL ON public.user_work_log TO service_role;
CREATE POLICY hitab_work_log_read ON public.user_work_log FOR SELECT TO authenticated
 USING (actor_id=auth.uid() OR public.has_role(auth.uid(),'admin'));

CREATE FUNCTION public.hitab_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE old_v jsonb; new_v jsonb; kind text; tid uuid; qid uuid; cid uuid; act text; source_tid text; source_qid text;
BEGIN
  IF TG_TABLE_NAME='tqa_tables' THEN
    kind:='table';tid:=NEW.id;
    old_v:=jsonb_build_object('title_id',OLD.title_id);
    new_v:=jsonb_build_object('title_id',NEW.title_id);
  ELSIF TG_TABLE_NAME='table_cells' THEN
    kind:='cell';tid:=NEW.table_id;cid:=NEW.id;
    old_v:=jsonb_build_object('target_text',OLD.target_text,'status',OLD.status);
    new_v:=jsonb_build_object('target_text',NEW.target_text,'status',NEW.status);
  ELSIF TG_TABLE_NAME='qa_pairs' THEN
    kind:='qa';tid:=NEW.table_id;qid:=NEW.id;
    old_v:=jsonb_build_object('question_id',OLD.question_id,'answer_id',OLD.answer_id,'status',OLD.status);
    new_v:=jsonb_build_object('question_id',NEW.question_id,'answer_id',NEW.answer_id,'status',NEW.status);
  ELSIF TG_TABLE_NAME='table_reviews' THEN
    kind:='table_review';tid:=NEW.table_id;
    old_v:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE jsonb_build_object('status',OLD.status,'reviewed_title_id',OLD.reviewed_title_id,'corrected_cells',OLD.corrected_cells) END;
    new_v:=jsonb_build_object('status',NEW.status,'reviewed_title_id',NEW.reviewed_title_id,'corrected_cells',NEW.corrected_cells);
  ELSE
    kind:='qa_review';qid:=NEW.qa_pair_id;
    SELECT table_id INTO tid FROM public.qa_pairs WHERE id=qid;
    old_v:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE jsonb_build_object('status',OLD.status,'reviewed_question_id',OLD.reviewed_question_id,'reviewed_answer_id',OLD.reviewed_answer_id,'logic_confirmed',OLD.logic_confirmed) END;
    new_v:=jsonb_build_object('status',NEW.status,'reviewed_question_id',NEW.reviewed_question_id,'reviewed_answer_id',NEW.reviewed_answer_id,'logic_confirmed',NEW.logic_confirmed);
  END IF;
  IF old_v IS NOT DISTINCT FROM new_v THEN RETURN NEW; END IF;
  act:=CASE WHEN TG_OP='INSERT' THEN 'created'
         WHEN new_v->>'status'='selesai' AND old_v->>'status' IS DISTINCT FROM 'selesai' THEN 'completed'
         WHEN old_v->>'status'='selesai' AND new_v->>'status' IS DISTINCT FROM 'selesai' THEN 'reopened'
         ELSE 'saved' END;
  SELECT original_table_id INTO source_tid FROM public.tqa_tables WHERE id=tid;
  IF qid IS NOT NULL THEN SELECT original_question_id INTO source_qid FROM public.qa_pairs WHERE id=qid; END IF;
  INSERT INTO public.user_work_log(actor_id,actor_role,item_type,table_id,qa_pair_id,cell_id,source_table_id,source_question_id,action,before_value,after_value)
  VALUES (auth.uid(), CASE WHEN auth.uid() IS NULL THEN 'system'
          WHEN public.has_role(auth.uid(),'admin') THEN 'admin'
          WHEN kind IN ('table_review','qa_review') AND act='reopened'
            AND public.has_role(auth.uid(),'anotator') THEN 'anotator'
          WHEN kind IN ('table_review','qa_review') THEN 'validator' ELSE 'anotator' END,
          kind,tid,qid,cid,source_tid,source_qid,act,old_v,new_v);
  RETURN NEW;
END;
$$;
CREATE TRIGGER hitab_audit_table AFTER UPDATE OF title_id ON public.tqa_tables
 FOR EACH ROW WHEN (OLD.title_id IS DISTINCT FROM NEW.title_id) EXECUTE FUNCTION public.hitab_audit_row();
CREATE TRIGGER hitab_audit_cell AFTER UPDATE OF target_text,status ON public.table_cells
 FOR EACH ROW WHEN (OLD.target_text IS DISTINCT FROM NEW.target_text OR OLD.status IS DISTINCT FROM NEW.status)
 EXECUTE FUNCTION public.hitab_audit_row();
CREATE TRIGGER hitab_audit_qa AFTER UPDATE OF question_id,answer_id,status ON public.qa_pairs
 FOR EACH ROW WHEN (OLD.question_id IS DISTINCT FROM NEW.question_id OR OLD.answer_id IS DISTINCT FROM NEW.answer_id OR OLD.status IS DISTINCT FROM NEW.status)
 EXECUTE FUNCTION public.hitab_audit_row();
CREATE TRIGGER hitab_audit_table_review AFTER INSERT OR UPDATE OF status,reviewed_title_id,corrected_cells ON public.table_reviews
 FOR EACH ROW EXECUTE FUNCTION public.hitab_audit_row();
CREATE TRIGGER hitab_audit_qa_review AFTER INSERT OR UPDATE OF status,reviewed_question_id,reviewed_answer_id,logic_confirmed ON public.qa_reviews
 FOR EACH ROW EXECUTE FUNCTION public.hitab_audit_row();

-- Atomic translator save: title and all modified header/row-label cells commit together.
CREATE FUNCTION public.hitab_save_table_translation(_table_id uuid,_title text,_cells jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(),'anotator') OR public.has_role(auth.uid(),'admin'))
    OR NOT EXISTS (SELECT 1 FROM public.tqa_tables WHERE id=_table_id AND annotate_flag=1) THEN
   RAISE EXCEPTION 'Annotation not allowed for this table';
 END IF;
 IF _cells IS NULL OR jsonb_typeof(_cells)<>'object' THEN RAISE EXCEPTION 'cells must be a JSON object'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(_cells) AS x(cell_id)
    WHERE NOT EXISTS (SELECT 1 FROM public.table_cells c WHERE c.table_id=_table_id AND c.id::text=x.cell_id)) THEN
   RAISE EXCEPTION 'Invalid cell ID for this table';
 END IF;
 UPDATE public.tqa_tables SET title_id=nullif(btrim(_title),'')
 WHERE id=_table_id AND title_id IS DISTINCT FROM nullif(btrim(_title),'');
 UPDATE public.table_cells c SET target_text=nullif(btrim(_cells ->> c.id::text),'')
 WHERE c.table_id=_table_id AND _cells ? c.id::text
   AND c.target_text IS DISTINCT FROM nullif(btrim(_cells ->> c.id::text),'');
END;
$$;
REVOKE ALL ON FUNCTION public.hitab_save_table_translation(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hitab_save_table_translation(uuid,text,jsonb) TO authenticated;

-- Independent sampling flags; the original ID is separate from the internal UUID.
CREATE FUNCTION public.hitab_set_sampling(_kind text,_source_id text,_flag integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF _flag NOT IN (0,1) THEN RAISE EXCEPTION 'flag must be 0 or 1'; END IF;
  IF _kind='table' THEN
    UPDATE public.tqa_tables SET annotate_flag=_flag WHERE original_table_id=_source_id;
  ELSIF _kind='qa' THEN
    UPDATE public.qa_pairs SET annotate_flag=_flag WHERE original_question_id=_source_id;
  ELSE RAISE EXCEPTION 'unknown sampling kind'; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'source ID not found'; END IF;
END;
$$;
-- Record opening a work item only when role, sampling, review-readiness and ownership allow it.
CREATE FUNCTION public.hitab_open_work(_kind text,_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE tid uuid; qid uuid; source_tid text; source_qid text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _kind='table' THEN
    IF NOT (public.has_role(auth.uid(),'anotator') OR public.has_role(auth.uid(),'admin'))
      OR NOT EXISTS (SELECT 1 FROM public.tqa_tables WHERE id=_id AND annotate_flag=1) THEN
      RAISE EXCEPTION 'Table not available for annotation'; END IF;
    tid:=_id;
  ELSIF _kind='qa' THEN
    IF NOT (public.has_role(auth.uid(),'anotator') OR public.has_role(auth.uid(),'admin'))
      OR NOT EXISTS (SELECT 1 FROM public.qa_pairs WHERE id=_id AND annotate_flag=1) THEN
      RAISE EXCEPTION 'QA not available for annotation'; END IF;
    qid:=_id;SELECT table_id INTO tid FROM public.qa_pairs WHERE id=qid;
  ELSIF _kind='table_review' THEN
    IF NOT (public.has_role(auth.uid(),'validator') OR public.has_role(auth.uid(),'admin'))
       OR NOT EXISTS (SELECT 1 FROM public.tqa_tables t WHERE t.id=_id AND t.annotate_flag=1
          AND nullif(btrim(t.title_id),'') IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id)
          AND NOT EXISTS (SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id AND (c.status<>'selesai' OR nullif(btrim(c.target_text),'') IS NULL)))
       OR EXISTS (SELECT 1 FROM public.table_reviews r WHERE r.table_id=_id AND r.reviewer_id<>auth.uid() AND NOT public.has_role(auth.uid(),'admin')) THEN
       RAISE EXCEPTION 'Table review unavailable'; END IF;
    tid:=_id;
  ELSIF _kind='qa_review' THEN
    IF NOT (public.has_role(auth.uid(),'validator') OR public.has_role(auth.uid(),'admin'))
       OR NOT EXISTS (SELECT 1 FROM public.qa_pairs q WHERE q.id=_id AND q.annotate_flag=1 AND q.status='selesai')
       OR EXISTS (SELECT 1 FROM public.qa_reviews r WHERE r.qa_pair_id=_id AND r.reviewer_id<>auth.uid() AND NOT public.has_role(auth.uid(),'admin')) THEN
       RAISE EXCEPTION 'QA review unavailable'; END IF;
    qid:=_id;SELECT table_id INTO tid FROM public.qa_pairs WHERE id=qid;
  ELSE RAISE EXCEPTION 'unknown work kind'; END IF;
  SELECT original_table_id INTO source_tid FROM public.tqa_tables WHERE id=tid;
  IF qid IS NOT NULL THEN SELECT original_question_id INTO source_qid FROM public.qa_pairs WHERE id=qid; END IF;
  INSERT INTO public.user_work_log(actor_id,actor_role,item_type,table_id,qa_pair_id,source_table_id,source_question_id,action)
  VALUES (auth.uid(),CASE WHEN public.has_role(auth.uid(),'admin') THEN 'admin'
           WHEN _kind IN ('table_review','qa_review') THEN 'validator' ELSE 'anotator' END,
          _kind,tid,qid,source_tid,source_qid,'opened');
END;
$$;

-- Reinforce server-side sampling, not just disabled UI buttons.
CREATE FUNCTION public.hitab_check_sampled_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE permitted boolean;
BEGIN
  IF TG_TABLE_NAME='tqa_tables' THEN
    IF NEW.title_id IS NOT DISTINCT FROM OLD.title_id THEN RETURN NEW; END IF;
    SELECT annotate_flag=1 INTO permitted FROM public.tqa_tables WHERE id=NEW.id;
  ELSIF TG_TABLE_NAME='table_cells' THEN
    IF NEW.target_text IS NOT DISTINCT FROM OLD.target_text THEN RETURN NEW; END IF;
    SELECT annotate_flag=1 INTO permitted FROM public.tqa_tables WHERE id=NEW.table_id;
  ELSIF TG_TABLE_NAME='qa_pairs' THEN
    IF NEW.question_id IS NOT DISTINCT FROM OLD.question_id AND NEW.answer_id IS NOT DISTINCT FROM OLD.answer_id THEN RETURN NEW; END IF;
    permitted:=NEW.annotate_flag=1;
  ELSIF TG_TABLE_NAME='table_reviews' THEN
    SELECT annotate_flag=1 INTO permitted FROM public.tqa_tables WHERE id=NEW.table_id;
  ELSE
    SELECT annotate_flag=1 INTO permitted FROM public.qa_pairs WHERE id=NEW.qa_pair_id;
  END IF;
  IF NOT COALESCE(permitted,false) THEN RAISE EXCEPTION 'Item is outside the annotation sample'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hitab_table_sample_guard BEFORE UPDATE OF title_id ON public.tqa_tables
 FOR EACH ROW EXECUTE FUNCTION public.hitab_check_sampled_write();
CREATE TRIGGER hitab_cell_sample_guard BEFORE UPDATE OF target_text ON public.table_cells
 FOR EACH ROW EXECUTE FUNCTION public.hitab_check_sampled_write();
CREATE TRIGGER hitab_qa_sample_guard BEFORE UPDATE OF question_id,answer_id ON public.qa_pairs
 FOR EACH ROW EXECUTE FUNCTION public.hitab_check_sampled_write();
CREATE TRIGGER hitab_table_review_sample_guard BEFORE INSERT OR UPDATE ON public.table_reviews
 FOR EACH ROW EXECUTE FUNCTION public.hitab_check_sampled_write();
CREATE TRIGGER hitab_qa_review_sample_guard BEFORE INSERT OR UPDATE ON public.qa_reviews
 FOR EACH ROW EXECUTE FUNCTION public.hitab_check_sampled_write();

-- Rebuild reviewer queues to respect INDEPENDENT table and QA sampling.
CREATE OR REPLACE FUNCTION public.review_queue(
  _kind text, _search text DEFAULT '', _status text DEFAULT 'semua',
  _limit integer DEFAULT 20, _offset integer DEFAULT 0
) RETURNS TABLE (
  item_id uuid, table_code text, source_text text, translated_text text,
  is_ready boolean, review_status text, reviewer_id uuid, total_count bigint
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH all_items AS (
    SELECT t.id item_id,t.code table_code,t.title_en source_text,t.title_id translated_text,
      (nullif(btrim(t.title_id),'') IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id)
       AND NOT EXISTS (SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id AND
         (nullif(btrim(c.target_text),'') IS NULL OR c.status<>'selesai'))) is_ready,
      COALESCE(r.status,'belum_diperiksa') review_status,r.reviewer_id,
      t.title_en table_title_en,t.title_id table_title_id
    FROM public.tqa_tables t LEFT JOIN public.table_reviews r ON r.table_id=t.id
    WHERE _kind='tabel' AND t.annotate_flag=1
    UNION ALL
    SELECT q.id,t.code,q.question_en,q.question_id,
      (nullif(btrim(q.question_id),'') IS NOT NULL AND nullif(btrim(q.answer_id),'') IS NOT NULL
       AND q.status='selesai'),COALESCE(r.status,'belum_diperiksa'),r.reviewer_id,t.title_en,t.title_id
    FROM public.qa_pairs q JOIN public.tqa_tables t ON t.id=q.table_id
      LEFT JOIN public.qa_reviews r ON r.qa_pair_id=q.id
    WHERE _kind='pertanyaan' AND q.annotate_flag=1
  ), filtered AS (
    SELECT * FROM all_items WHERE (_search='' OR table_code ILIKE '%'||_search||'%'
      OR source_text ILIKE '%'||_search||'%' OR translated_text ILIKE '%'||_search||'%'
      OR table_title_en ILIKE '%'||_search||'%' OR table_title_id ILIKE '%'||_search||'%')
      AND (_status='semua' OR review_status=_status)
      AND (public.has_role(auth.uid(),'validator') OR public.has_role(auth.uid(),'admin'))
  )
  SELECT f.item_id,f.table_code,f.source_text,f.translated_text,f.is_ready,f.review_status,f.reviewer_id,
    (SELECT count(*) FROM filtered) total_count FROM filtered f ORDER BY f.table_code,f.item_id
    LIMIT LEAST(GREATEST(_limit,1),100) OFFSET GREATEST(_offset,0);
$$;
CREATE OR REPLACE FUNCTION public.review_queue_counts(_kind text,_search text DEFAULT '')
RETURNS TABLE(total bigint,belum bigint,sedang bigint,selesai bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT count(*),count(*) FILTER (WHERE x.status='belum_diperiksa'),
    count(*) FILTER (WHERE x.status='sedang_diperiksa'),count(*) FILTER (WHERE x.status='selesai')
  FROM (
    SELECT t.code,t.title_en,t.title_id,COALESCE(r.status,'belum_diperiksa') status,
      t.title_en source_text,t.title_id translated_text
    FROM public.tqa_tables t LEFT JOIN public.table_reviews r ON r.table_id=t.id
    WHERE _kind='tabel' AND t.annotate_flag=1
    UNION ALL
    SELECT t.code,t.title_en,t.title_id,COALESCE(r.status,'belum_diperiksa'),q.question_en,q.question_id
    FROM public.qa_pairs q JOIN public.tqa_tables t ON t.id=q.table_id
      LEFT JOIN public.qa_reviews r ON r.qa_pair_id=q.id
    WHERE _kind='pertanyaan' AND q.annotate_flag=1
  ) x WHERE (_search='' OR x.code ILIKE '%'||_search||'%'
    OR x.source_text ILIKE '%'||_search||'%' OR x.translated_text ILIKE '%'||_search||'%'
    OR x.title_en ILIKE '%'||_search||'%' OR x.title_id ILIKE '%'||_search||'%')
    AND (public.has_role(auth.uid(),'validator') OR public.has_role(auth.uid(),'admin'));
$$;

-- Server aggregates avoid Supabase's default 1,000-row REST response limit.
CREATE FUNCTION public.hitab_progress()
RETURNS TABLE(tables_total bigint,titles_done bigint,cells_total bigint,cells_done bigint,qa_total bigint,qa_done bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
 SELECT
   (SELECT count(*) FROM public.tqa_tables t WHERE t.annotate_flag=1),
   (SELECT count(*) FROM public.tqa_tables t WHERE t.annotate_flag=1 AND nullif(btrim(t.title_id),'') IS NOT NULL),
   (SELECT count(*) FROM public.table_cells c JOIN public.tqa_tables t ON t.id=c.table_id WHERE t.annotate_flag=1),
   (SELECT count(*) FROM public.table_cells c JOIN public.tqa_tables t ON t.id=c.table_id
       WHERE t.annotate_flag=1 AND nullif(btrim(c.target_text),'') IS NOT NULL),
   (SELECT count(*) FROM public.qa_pairs q WHERE q.annotate_flag=1),
   (SELECT count(*) FROM public.qa_pairs q WHERE q.annotate_flag=1 AND q.status='selesai'
       AND nullif(btrim(q.question_id),'') IS NOT NULL AND nullif(btrim(q.answer_id),'') IS NOT NULL);
$$;
CREATE FUNCTION public.hitab_user_contributions()
RETURNS TABLE(user_id uuid,full_name text,email text,entry_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
 WITH edits AS (
   SELECT c.updated_by actor,count(*) cnt FROM public.table_cells c JOIN public.tqa_tables t ON t.id=c.table_id
     WHERE t.annotate_flag=1 AND nullif(btrim(c.target_text),'') IS NOT NULL AND c.updated_by IS NOT NULL
     GROUP BY c.updated_by
   UNION ALL
   SELECT q.updated_by,count(*) FROM public.qa_pairs q WHERE q.annotate_flag=1 AND
     nullif(btrim(q.question_id),'') IS NOT NULL AND q.updated_by IS NOT NULL GROUP BY q.updated_by
 ), tally AS (SELECT actor,sum(cnt)::bigint n FROM edits GROUP BY actor)
 SELECT tally.actor,p.full_name,p.email,tally.n FROM tally LEFT JOIN public.profiles p ON p.id=tally.actor
 ORDER BY tally.n DESC,tally.actor;
$$;
REVOKE ALL ON FUNCTION public.hitab_progress(),public.hitab_user_contributions() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hitab_progress(),public.hitab_user_contributions() TO authenticated;

-- Fix permissive legacy GRANTs: clients can only edit translation or review output fields.
REVOKE UPDATE ON public.tqa_tables,public.table_cells,public.qa_pairs,public.table_reviews,public.qa_reviews FROM authenticated;
REVOKE INSERT,DELETE ON public.tqa_tables,public.table_cells,public.qa_pairs FROM authenticated;
REVOKE DELETE ON public.table_reviews,public.qa_reviews FROM authenticated;
GRANT UPDATE(title_id) ON public.tqa_tables TO authenticated;
GRANT UPDATE(target_text) ON public.table_cells TO authenticated;
GRANT UPDATE(question_id,answer_id) ON public.qa_pairs TO authenticated;
GRANT UPDATE(status,reviewed_title_id,corrected_cells) ON public.table_reviews TO authenticated;
GRANT UPDATE(status,reviewed_question_id,reviewed_answer_id,logic_confirmed) ON public.qa_reviews TO authenticated;
-- UI/admin sample update through guarded RPC, not arbitrary row updates.
REVOKE ALL ON FUNCTION public.hitab_set_sampling(text,text,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.hitab_open_work(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hitab_set_sampling(text,text,integer),public.hitab_open_work(text,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.hitab_refresh_annotated_table(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.hitab_source_guard(),public.hitab_translation_guard(),
  public.hitab_refresh_annotated_table_trigger(),public.hitab_refresh_annotated_qa_trigger(),
  public.hitab_review_snapshot_trigger(),public.hitab_audit_row(),public.hitab_check_sampled_write(),public.hitab_refresh_cell_batch()
  FROM PUBLIC,anon,authenticated;

-- Additional QA completion rule: the validator must explicitly confirm original computation metadata.
CREATE OR REPLACE FUNCTION public.check_qa_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NEW.status='selesai' THEN
   IF NOT EXISTS (SELECT 1 FROM public.qa_pairs q WHERE q.id=NEW.qa_pair_id
         AND q.annotate_flag=1 AND nullif(btrim(q.question_id),'') IS NOT NULL
         AND nullif(btrim(q.answer_id),'') IS NOT NULL AND q.status='selesai') THEN
     RAISE EXCEPTION 'Question and answer must be completely translated and sampled';
   END IF;
   IF nullif(btrim(NEW.reviewed_question_id),'') IS NULL OR nullif(btrim(NEW.reviewed_answer_id),'') IS NULL THEN
     RAISE EXCEPTION 'Complete the reviewed question and answer';
   END IF;
   IF EXISTS (SELECT 1 FROM public.qa_pairs WHERE id=NEW.qa_pair_id AND original_qa IS NOT NULL)
      AND NOT NEW.logic_confirmed THEN
     RAISE EXCEPTION 'Check the original answer, aggregation, formulas and linked cells first';
   END IF;
   NEW.completed_at:=COALESCE(NEW.completed_at,now());
 ELSE NEW.completed_at:=NULL;
 END IF;
 NEW.updated_at:=now();
 RETURN NEW;
END;
$$;

-- Existing old translation records remain untouched; snapshots only if a genuine original JSON exists.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT id FROM public.tqa_tables WHERE original_table IS NOT NULL AND annotated_table IS NULL LOOP
   PERFORM public.hitab_refresh_annotated_table(t.id);
 END LOOP;
END $$;
UPDATE public.qa_pairs SET annotated_qa=original_qa || jsonb_build_object('question_id',question_id,'answer_id',answer_id)
 WHERE original_qa IS NOT NULL AND annotated_qa IS NULL;
-- Existing reviewed content is not silently treated as having a verified original JSON.
COMMIT;
