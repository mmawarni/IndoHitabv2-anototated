-- IndoHiTAB v6. Apply ONCE after v5 migration 20260918150000.
-- Back up your live Supabase project before running. No source/translation/QA rows are deleted.
BEGIN;

-- Role administration is a SET of roles, not a single dropdown choice.
-- This procedure replaces all a user's roles atomically; empty array = pending.
CREATE FUNCTION public.admin_set_user_roles(_user_id uuid, _roles public.app_role[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE current_roles public.app_role[]; requested public.app_role[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'Only Admin can set roles';
  END IF;
  IF _roles IS NULL OR array_position(_roles,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Provide a non-null array of roles';
  END IF;
  -- Serialize role changes so concurrent requests cannot remove the last Admin.
  PERFORM pg_advisory_xact_lock(260918, 2026);
  PERFORM 1 FROM public.profiles WHERE id=_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  SELECT COALESCE(array_agg(DISTINCT r.role),ARRAY[]::public.app_role[])
    INTO current_roles FROM public.user_roles r WHERE r.user_id=_user_id;
  SELECT COALESCE(array_agg(DISTINCT x.role),ARRAY[]::public.app_role[])
    INTO requested FROM unnest(_roles) AS x(role);
  IF 'admin'::public.app_role = ANY(current_roles)
     AND NOT ('admin'::public.app_role = ANY(requested))
     AND (SELECT count(*) FROM public.user_roles WHERE role='admin') <= 1 THEN
    RAISE EXCEPTION 'Cannot remove the last Admin';
  END IF;
  DELETE FROM public.user_roles WHERE user_id=_user_id AND NOT (role=ANY(requested));
  INSERT INTO public.user_roles(user_id,role)
    SELECT _user_id, x.role FROM unnest(requested) AS x(role) WHERE true
    ON CONFLICT(user_id,role) DO NOTHING;
  UPDATE public.profiles
    SET status=CASE WHEN cardinality(requested)=0 THEN 'menunggu_peran'
                    WHEN status='menunggu_peran' THEN 'aktif'
                    ELSE status END
    WHERE id=_user_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_user_roles(uuid,public.app_role[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_roles(uuid,public.app_role[]) TO authenticated;
-- Disable the v4 single-role endpoint so a stale client cannot silently erase extra roles.
REVOKE ALL ON FUNCTION public.admin_set_user_role(uuid,public.app_role) FROM PUBLIC,anon,authenticated;

-- Never allow direct authenticated writes that bypass the atomic role procedure.
REVOKE INSERT,UPDATE,DELETE ON public.user_roles FROM authenticated;

-- An Admin can take either work role; a Validator may ALSO translate assigned items.
CREATE OR REPLACE FUNCTION public.hitab_validate_assignee(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT _user_id IS NULL OR EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id=_user_id AND p.status='aktif'
      AND (
        public.has_role(_user_id,'admin')
        OR (_role='anotator' AND (public.has_role(_user_id,'anotator') OR public.has_role(_user_id,'validator')))
        OR (_role='validator' AND public.has_role(_user_id,'validator'))
      )
  );
$$;
REVOKE ALL ON FUNCTION public.hitab_validate_assignee(uuid,public.app_role) FROM PUBLIC,anon,authenticated;

-- Centralized assignment permission: role AND explicit assignment, not just role.
CREATE FUNCTION public.hitab_is_assigned_annotator(_user_id uuid,_assigned_to uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT _user_id IS NOT NULL AND _assigned_to=_user_id
    AND public.hitab_validate_assignee(_user_id,'anotator');
$$;
REVOKE ALL ON FUNCTION public.hitab_is_assigned_annotator(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hitab_is_assigned_annotator(uuid,uuid) TO authenticated;

-- Replaces v4 single-assignment implementation. A completed review's reviewer must not
-- be silently rewritten to a different person (that would falsify provenance).
CREATE OR REPLACE FUNCTION public.admin_assign_work(
  _kind text, _source_id text, _annotator_id uuid DEFAULT NULL, _validator_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target_id uuid; prior_reviewer uuid; review_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF _source_id IS NULL OR btrim(_source_id)='' THEN RAISE EXCEPTION 'Source ID is required'; END IF;
  IF NOT public.hitab_validate_assignee(_annotator_id,'anotator') THEN
    RAISE EXCEPTION 'Selected annotator must be active and have an eligible role';
  END IF;
  IF NOT public.hitab_validate_assignee(_validator_id,'validator') THEN
    RAISE EXCEPTION 'Selected validator must be active and have Validator/Admin role';
  END IF;
  IF _annotator_id IS NOT NULL AND _annotator_id=_validator_id THEN
    RAISE EXCEPTION 'Annotator and Validator must be different people for the same item';
  END IF;
  IF _kind='table' THEN
    SELECT id INTO target_id FROM public.tqa_tables WHERE original_table_id=_source_id FOR UPDATE;
    IF target_id IS NULL THEN RAISE EXCEPTION 'Table ID not found: %',_source_id; END IF;
    SELECT reviewer_id,status INTO prior_reviewer,review_status FROM public.table_reviews WHERE table_id=target_id FOR UPDATE;
    IF review_status='selesai' AND _validator_id IS DISTINCT FROM prior_reviewer THEN
      RAISE EXCEPTION 'Completed table review cannot be reassigned without a separate review-reopening workflow: %',_source_id;
    END IF;
    UPDATE public.tqa_tables SET annotator_id=_annotator_id,validator_id=_validator_id,assigned_to=_annotator_id
      WHERE id=target_id;
    IF _validator_id IS NOT NULL AND prior_reviewer IS DISTINCT FROM _validator_id THEN
      UPDATE public.table_reviews SET reviewer_id=_validator_id WHERE table_id=target_id;
    END IF;
  ELSIF _kind='qa' THEN
    SELECT id INTO target_id FROM public.qa_pairs WHERE original_question_id=_source_id FOR UPDATE;
    IF target_id IS NULL THEN RAISE EXCEPTION 'Question ID not found: %',_source_id; END IF;
    SELECT reviewer_id,status INTO prior_reviewer,review_status FROM public.qa_reviews WHERE qa_pair_id=target_id FOR UPDATE;
    IF review_status='selesai' AND _validator_id IS DISTINCT FROM prior_reviewer THEN
      RAISE EXCEPTION 'Completed QA review cannot be reassigned without a separate review-reopening workflow: %',_source_id;
    END IF;
    UPDATE public.qa_pairs SET annotator_id=_annotator_id,validator_id=_validator_id WHERE id=target_id;
    IF _validator_id IS NOT NULL AND prior_reviewer IS DISTINCT FROM _validator_id THEN
      UPDATE public.qa_reviews SET reviewer_id=_validator_id WHERE qa_pair_id=target_id;
    END IF;
  ELSE RAISE EXCEPTION 'kind must be table or qa'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_assign_work(text,text,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_work(text,text,uuid,uuid) TO authenticated;

-- ONE transaction for all checked IDs. No partial successful assignments on failure.
-- Bound selections to one UI page: 1..100 distinct original IDs, no null IDs.
CREATE FUNCTION public.admin_bulk_assign_work(
  _kind text, _source_ids text[], _annotator_id uuid DEFAULT NULL, _validator_id uuid DEFAULT NULL,
  _change_annotator boolean DEFAULT true, _change_validator boolean DEFAULT true
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE sid text; expected integer; found_count integer; old_annotator uuid; old_validator uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF _kind NOT IN ('table','qa') OR _kind IS NULL THEN RAISE EXCEPTION 'Invalid assignment kind'; END IF;
  IF NOT COALESCE(_change_annotator,false) AND NOT COALESCE(_change_validator,false) THEN
    RAISE EXCEPTION 'Choose at least one assignment field to change';
  END IF;
  expected:=COALESCE(cardinality(_source_ids),0);
  IF expected<1 OR expected>100 THEN RAISE EXCEPTION 'Select 1 to 100 items at a time'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(_source_ids) AS x(source_id) WHERE x.source_id IS NULL OR btrim(x.source_id)='') THEN
    RAISE EXCEPTION 'All selected items must have original IDs';
  END IF;
  IF (SELECT count(DISTINCT x.source_id) FROM unnest(_source_ids) AS x(source_id))<>expected THEN
    RAISE EXCEPTION 'Duplicate original IDs in selection';
  END IF;
  IF _kind='table' THEN
    SELECT count(*) INTO found_count FROM public.tqa_tables WHERE original_table_id=ANY(_source_ids);
  ELSE
    SELECT count(*) INTO found_count FROM public.qa_pairs WHERE original_question_id=ANY(_source_ids);
  END IF;
  IF found_count<>expected THEN RAISE EXCEPTION 'Some selected source IDs no longer exist; refresh the queue'; END IF;
  FOREACH sid IN ARRAY _source_ids LOOP
    IF _kind='table' THEN
      SELECT annotator_id,validator_id INTO old_annotator,old_validator
        FROM public.tqa_tables WHERE original_table_id=sid FOR UPDATE;
    ELSE
      SELECT annotator_id,validator_id INTO old_annotator,old_validator
        FROM public.qa_pairs WHERE original_question_id=sid FOR UPDATE;
    END IF;
    PERFORM public.admin_assign_work(_kind,sid,
      CASE WHEN _change_annotator THEN _annotator_id ELSE old_annotator END,
      CASE WHEN _change_validator THEN _validator_id ELSE old_validator END);
  END LOOP;
  RETURN expected;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_bulk_assign_work(text,text[],uuid,uuid,boolean,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_bulk_assign_work(text,text[],uuid,uuid,boolean,boolean) TO authenticated;

-- Legacy RLS policies must not OR into permissive access for any authenticated user.
DROP POLICY IF EXISTS "tqa_tables_update_workers" ON public.tqa_tables;
DROP POLICY IF EXISTS "table_cells_update_workers" ON public.table_cells;
DROP POLICY IF EXISTS "qa_pairs_update_workers" ON public.qa_pairs;
DROP POLICY IF EXISTS tqa_tables_translate ON public.tqa_tables;
DROP POLICY IF EXISTS table_cells_translate ON public.table_cells;
DROP POLICY IF EXISTS qa_pairs_translate ON public.qa_pairs;
CREATE POLICY tqa_tables_translate ON public.tqa_tables FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.hitab_is_assigned_annotator(auth.uid(),annotator_id))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR public.hitab_is_assigned_annotator(auth.uid(),annotator_id));
CREATE POLICY table_cells_translate ON public.table_cells FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR EXISTS (
      SELECT 1 FROM public.tqa_tables t WHERE t.id=table_id
        AND public.hitab_is_assigned_annotator(auth.uid(),t.annotator_id)))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR EXISTS (
      SELECT 1 FROM public.tqa_tables t WHERE t.id=table_id
        AND public.hitab_is_assigned_annotator(auth.uid(),t.annotator_id)));
CREATE POLICY qa_pairs_translate ON public.qa_pairs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.hitab_is_assigned_annotator(auth.uid(),annotator_id))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR public.hitab_is_assigned_annotator(auth.uid(),annotator_id));

-- Table save + opened-work RPC must also allow Validator who was assigned as Anotator.
CREATE OR REPLACE FUNCTION public.hitab_save_table_translation(_table_id uuid,_title text,_cells jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE kv record; changed integer;
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin') OR EXISTS (
    SELECT 1 FROM public.tqa_tables t WHERE t.id=_table_id AND t.annotate_flag=1
      AND public.hitab_is_assigned_annotator(auth.uid(),t.annotator_id))) THEN
    RAISE EXCEPTION 'Table is not assigned to this annotator';
  END IF;
  IF jsonb_typeof(_cells) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'cells must be object'; END IF;
  UPDATE public.tqa_tables SET title_id=NULLIF(btrim(_title),'') WHERE id=_table_id;
  FOR kv IN SELECT key,value FROM jsonb_each_text(_cells) LOOP
    UPDATE public.table_cells SET target_text=NULLIF(btrim(kv.value),''),
      status=CASE WHEN nullif(btrim(kv.value),'') IS NULL THEN 'draft' ELSE 'selesai' END,
      updated_by=auth.uid(),updated_at=now()
    WHERE id=kv.key::uuid AND table_id=_table_id;
    GET DIAGNOSTICS changed=ROW_COUNT;
    IF changed<>1 THEN RAISE EXCEPTION 'Invalid cell % for table',kv.key; END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.hitab_open_work(_kind text,_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE tid uuid; qid uuid; source_tid text; source_qid text;
BEGIN
  IF _kind='table' THEN
    IF NOT (public.has_role(auth.uid(),'admin') OR EXISTS (
      SELECT 1 FROM public.tqa_tables t WHERE t.id=_id AND t.annotate_flag=1
        AND public.hitab_is_assigned_annotator(auth.uid(),t.annotator_id))) THEN
      RAISE EXCEPTION 'Table not assigned to this annotator'; END IF;
    tid:=_id;
  ELSIF _kind='qa' THEN
    IF NOT (public.has_role(auth.uid(),'admin') OR EXISTS (
      SELECT 1 FROM public.qa_pairs q WHERE q.id=_id AND q.annotate_flag=1
        AND public.hitab_is_assigned_annotator(auth.uid(),q.annotator_id))) THEN
      RAISE EXCEPTION 'QA not assigned to this annotator'; END IF;
    qid:=_id; SELECT table_id INTO tid FROM public.qa_pairs WHERE id=qid;
  ELSIF _kind='table_review' THEN
    IF NOT (public.has_role(auth.uid(),'admin') OR EXISTS (
      SELECT 1 FROM public.tqa_tables t WHERE t.id=_id AND t.annotate_flag=1
        AND t.validator_id=auth.uid() AND public.has_role(auth.uid(),'validator')
        AND nullif(btrim(t.title_id),'') IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id)
        AND NOT EXISTS (SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id
          AND (c.status<>'selesai' OR nullif(btrim(c.target_text),'') IS NULL)))) THEN
      RAISE EXCEPTION 'Table review not assigned or not ready'; END IF;
    tid:=_id;
  ELSIF _kind='qa_review' THEN
    IF NOT (public.has_role(auth.uid(),'admin') OR EXISTS (
      SELECT 1 FROM public.qa_pairs q WHERE q.id=_id AND q.annotate_flag=1
        AND q.validator_id=auth.uid() AND public.has_role(auth.uid(),'validator') AND q.status='selesai')) THEN
      RAISE EXCEPTION 'QA review not assigned or not ready'; END IF;
    qid:=_id; SELECT table_id INTO tid FROM public.qa_pairs WHERE id=qid;
  ELSE RAISE EXCEPTION 'unknown work kind'; END IF;
  SELECT original_table_id INTO source_tid FROM public.tqa_tables WHERE id=tid;
  IF qid IS NOT NULL THEN SELECT original_question_id INTO source_qid FROM public.qa_pairs WHERE id=qid; END IF;
  INSERT INTO public.user_work_log(actor_id,actor_role,item_type,table_id,qa_pair_id,source_table_id,source_question_id,action)
  VALUES (auth.uid(),CASE WHEN _kind IN ('table_review','qa_review') THEN 'validator'
            ELSE 'anotator' END,
          _kind,tid,qid,source_tid,source_qid,'opened');
END;
$$;

-- Scope direct SELECT access as well as the dashboard: a worker may read a table
-- assigned to them OR a parent table needed for an assigned QA. They may only
-- read QA assigned to them. Validator/Admin have a global read view.
-- SECURITY DEFINER helpers avoid recursive RLS evaluation through the QA/table join.
CREATE FUNCTION public.hitab_can_read_table(_table_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (
    (EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.status='aktif')
      AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'validator')))
    OR EXISTS(SELECT 1 FROM public.tqa_tables t WHERE t.id=_table_id
      AND t.annotate_flag=1 AND public.hitab_is_assigned_annotator(auth.uid(),t.annotator_id))
    OR EXISTS(SELECT 1 FROM public.qa_pairs q WHERE q.table_id=_table_id
      AND q.annotate_flag=1 AND public.hitab_is_assigned_annotator(auth.uid(),q.annotator_id))
  );
$$;
CREATE FUNCTION public.hitab_can_read_qa(_qa_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (
    (EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.status='aktif')
      AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'validator')))
    OR EXISTS(SELECT 1 FROM public.qa_pairs q WHERE q.id=_qa_id
      AND q.annotate_flag=1 AND public.hitab_is_assigned_annotator(auth.uid(),q.annotator_id))
  );
$$;
REVOKE ALL ON FUNCTION public.hitab_can_read_table(uuid),public.hitab_can_read_qa(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hitab_can_read_table(uuid),public.hitab_can_read_qa(uuid) TO authenticated;
DROP POLICY IF EXISTS "tqa_tables_select_authenticated" ON public.tqa_tables;
DROP POLICY IF EXISTS "table_cells_select_authenticated" ON public.table_cells;
DROP POLICY IF EXISTS "qa_pairs_select_authenticated" ON public.qa_pairs;
CREATE POLICY hitab_tables_scope ON public.tqa_tables FOR SELECT TO authenticated
  USING (public.hitab_can_read_table(id));
CREATE POLICY hitab_cells_scope ON public.table_cells FOR SELECT TO authenticated
  USING (public.hitab_can_read_table(table_id));
CREATE POLICY hitab_qa_scope ON public.qa_pairs FOR SELECT TO authenticated
  USING (public.hitab_can_read_qa(id));

-- Dashboard: Admin and Validator see global sampled work. Only assigned, independently
-- sampled tables/QA count for an Anotator. Pending users receive zeros.
CREATE OR REPLACE FUNCTION public.hitab_progress()
RETURNS TABLE(tables_total bigint,titles_done bigint,cells_total bigint,cells_done bigint,qa_total bigint,qa_done bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 WITH scope AS (
   SELECT ((public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'validator'))
            AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.status='aktif')) global_view,
          public.hitab_validate_assignee(auth.uid(),'anotator') worker
 ), my_tables AS (
   SELECT t.id,t.title_id FROM public.tqa_tables t CROSS JOIN scope s
   WHERE t.annotate_flag=1 AND (s.global_view OR (s.worker AND t.annotator_id=auth.uid()))
 ), my_qa AS (
   SELECT q.id,q.question_id,q.answer_id,q.status FROM public.qa_pairs q CROSS JOIN scope s
   WHERE q.annotate_flag=1 AND (s.global_view OR (s.worker AND q.annotator_id=auth.uid()))
 )
 SELECT (SELECT count(*) FROM my_tables),
        (SELECT count(*) FROM my_tables WHERE nullif(btrim(title_id),'') IS NOT NULL),
        (SELECT count(*) FROM public.table_cells c JOIN my_tables t ON t.id=c.table_id),
        (SELECT count(*) FROM public.table_cells c JOIN my_tables t ON t.id=c.table_id
         WHERE nullif(btrim(c.target_text),'') IS NOT NULL),
        (SELECT count(*) FROM my_qa),
        (SELECT count(*) FROM my_qa WHERE status='selesai'
          AND nullif(btrim(question_id),'') IS NOT NULL AND nullif(btrim(answer_id),'') IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION public.hitab_progress() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hitab_progress() TO authenticated;

CREATE OR REPLACE FUNCTION public.hitab_user_contributions()
RETURNS TABLE(user_id uuid,full_name text,email text,entry_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 WITH scope AS (
   SELECT ((public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'validator'))
            AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.status='aktif')) global_view,
          public.hitab_validate_assignee(auth.uid(),'anotator') worker
 ), edits AS (
   SELECT c.updated_by actor,count(*) cnt FROM public.table_cells c
     JOIN public.tqa_tables t ON t.id=c.table_id CROSS JOIN scope s
     WHERE t.annotate_flag=1 AND nullif(btrim(c.target_text),'') IS NOT NULL
       AND c.updated_by IS NOT NULL AND (s.global_view OR (s.worker AND t.annotator_id=auth.uid() AND c.updated_by=auth.uid()))
     GROUP BY c.updated_by
   UNION ALL
   SELECT q.updated_by,count(*) FROM public.qa_pairs q CROSS JOIN scope s
     WHERE q.annotate_flag=1 AND nullif(btrim(q.question_id),'') IS NOT NULL
       AND q.updated_by IS NOT NULL AND (s.global_view OR (s.worker AND q.annotator_id=auth.uid() AND q.updated_by=auth.uid()))
     GROUP BY q.updated_by
 ), tally AS (SELECT actor,sum(cnt)::bigint n FROM edits GROUP BY actor)
 SELECT tally.actor,p.full_name,p.email,tally.n
 FROM tally LEFT JOIN public.profiles p ON p.id=tally.actor
 ORDER BY tally.n DESC,tally.actor;
$$;
REVOKE ALL ON FUNCTION public.hitab_user_contributions() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hitab_user_contributions() TO authenticated;

COMMIT;
