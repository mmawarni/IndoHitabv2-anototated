-- IndoHiTAB v4: explicit role approval + explicit annotator/validator work assignment.
-- Run AFTER 20260918110000_preserve_hitab_sampling_audit.sql.
-- New sign-ups get a profile only; an Admin must assign a role before work menus become available.
BEGIN;

-- 1) New accounts are pending until an Admin explicitly chooses a role.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, status)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.email, ''),
    'menunggu_peran'
  )
  ON CONFLICT (id) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        email = EXCLUDED.email;
  -- Deliberately do NOT insert user_roles here.
  RETURN NEW;
END;
$$;

-- Existing accounts keep their current role. Only accounts with no role become visibly pending.
UPDATE public.profiles p
SET status = 'menunggu_peran'
WHERE NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.id)
  AND p.status = 'aktif';

-- Atomic Admin-only role assignment. NULL removes the working role and returns the account to pending.
CREATE OR REPLACE FUNCTION public.admin_set_user_role(_user_id uuid, _role public.app_role DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE admin_count integer;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only Admin can assign user roles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- Do not allow removing/demoting the only Admin.
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role='admin')
     AND _role IS DISTINCT FROM 'admin'::public.app_role THEN
    SELECT count(*) INTO admin_count FROM public.user_roles WHERE role='admin';
    IF admin_count <= 1 THEN
      RAISE EXCEPTION 'Cannot remove the last Admin';
    END IF;
  END IF;

  DELETE FROM public.user_roles WHERE user_id = _user_id;
  IF _role IS NOT NULL THEN
    INSERT INTO public.user_roles(user_id, role) VALUES (_user_id, _role);
    UPDATE public.profiles SET status='aktif' WHERE id=_user_id AND status='menunggu_peran';
  ELSE
    UPDATE public.profiles SET status='menunggu_peran' WHERE id=_user_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_user_role(uuid,public.app_role) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(uuid,public.app_role) TO authenticated;

-- 2) Explicit work assignment. Keep legacy assigned_to but use the new role-specific columns.
ALTER TABLE public.tqa_tables
  ADD COLUMN IF NOT EXISTS annotator_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS validator_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.qa_pairs
  ADD COLUMN IF NOT EXISTS annotator_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS validator_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Preserve any legacy table assignment as the initial annotator assignment.
UPDATE public.tqa_tables SET annotator_id = assigned_to
WHERE annotator_id IS NULL AND assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS hitab_table_annotator_idx ON public.tqa_tables(annotator_id) WHERE annotate_flag=1;
CREATE INDEX IF NOT EXISTS hitab_table_validator_idx ON public.tqa_tables(validator_id) WHERE annotate_flag=1;
CREATE INDEX IF NOT EXISTS hitab_qa_annotator_idx ON public.qa_pairs(annotator_id) WHERE annotate_flag=1;
CREATE INDEX IF NOT EXISTS hitab_qa_validator_idx ON public.qa_pairs(validator_id) WHERE annotate_flag=1;

-- Validate role/active status when assigning work.
CREATE OR REPLACE FUNCTION public.hitab_validate_assignee(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NULL OR EXISTS (
    SELECT 1
    FROM public.user_roles r
    JOIN public.profiles p ON p.id=r.user_id
    WHERE r.user_id=_user_id AND r.role=_role AND p.status='aktif'
  );
$$;

-- Admin assignment is by original HiTAB ID (table ID or question ID), not internal UUID.
CREATE OR REPLACE FUNCTION public.admin_assign_work(
  _kind text,
  _source_id text,
  _annotator_id uuid DEFAULT NULL,
  _validator_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE target_id uuid;
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'Only Admin can assign work';
  END IF;
  IF NOT public.hitab_validate_assignee(_annotator_id,'anotator') THEN
    RAISE EXCEPTION 'Selected annotator is not an active Anotator';
  END IF;
  IF NOT public.hitab_validate_assignee(_validator_id,'validator') THEN
    RAISE EXCEPTION 'Selected validator is not an active Validator';
  END IF;

  IF _kind='table' THEN
    SELECT id INTO target_id FROM public.tqa_tables WHERE original_table_id=_source_id;
    IF target_id IS NULL THEN RAISE EXCEPTION 'Table ID not found: %', _source_id; END IF;
    UPDATE public.tqa_tables
      SET annotator_id=_annotator_id, validator_id=_validator_id, assigned_to=_annotator_id
      WHERE id=target_id;
    -- Keep an already-created review usable after an explicit Admin reassignment.
    IF _validator_id IS NOT NULL THEN
      UPDATE public.table_reviews SET reviewer_id=_validator_id WHERE table_id=target_id;
    END IF;
  ELSIF _kind='qa' THEN
    SELECT id INTO target_id FROM public.qa_pairs WHERE original_question_id=_source_id;
    IF target_id IS NULL THEN RAISE EXCEPTION 'Question ID not found: %', _source_id; END IF;
    UPDATE public.qa_pairs SET annotator_id=_annotator_id, validator_id=_validator_id WHERE id=target_id;
    IF _validator_id IS NOT NULL THEN
      UPDATE public.qa_reviews SET reviewer_id=_validator_id WHERE qa_pair_id=target_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'kind must be table or qa';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_assign_work(text,text,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_work(text,text,uuid,uuid) TO authenticated;

-- Paginated Admin queue used by the assignment menu.
CREATE OR REPLACE FUNCTION public.assignment_queue(
  _kind text,
  _search text DEFAULT '',
  _limit integer DEFAULT 30,
  _offset integer DEFAULT 0
) RETURNS TABLE(
  item_id uuid,
  source_id text,
  table_code text,
  source_text text,
  annotate_flag integer,
  annotator_id uuid,
  validator_id uuid,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH items AS (
    SELECT t.id item_id,t.original_table_id source_id,t.code table_code,t.title_en source_text,
           t.annotate_flag,t.annotator_id,t.validator_id
    FROM public.tqa_tables t WHERE _kind='table'
    UNION ALL
    SELECT q.id,q.original_question_id,t.code,q.question_en,q.annotate_flag,q.annotator_id,q.validator_id
    FROM public.qa_pairs q JOIN public.tqa_tables t ON t.id=q.table_id WHERE _kind='qa'
  ), filtered AS (
    SELECT * FROM items
    WHERE public.has_role(auth.uid(),'admin')
      AND (_search='' OR source_id ILIKE '%'||_search||'%' OR table_code ILIKE '%'||_search||'%'
           OR source_text ILIKE '%'||_search||'%')
  )
  SELECT f.*, (SELECT count(*) FROM filtered)
  FROM filtered f
  ORDER BY f.table_code,f.source_id NULLS LAST,f.item_id
  LIMIT LEAST(GREATEST(_limit,1),100) OFFSET GREATEST(_offset,0);
$$;
REVOKE ALL ON FUNCTION public.assignment_queue(text,text,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.assignment_queue(text,text,integer,integer) TO authenticated;

-- 3) Translation writes are restricted to the assigned annotator (Admin can override).
DROP POLICY IF EXISTS tqa_tables_translate ON public.tqa_tables;
DROP POLICY IF EXISTS table_cells_translate ON public.table_cells;
DROP POLICY IF EXISTS qa_pairs_translate ON public.qa_pairs;
CREATE POLICY tqa_tables_translate ON public.tqa_tables FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR
         (public.has_role(auth.uid(),'anotator') AND annotator_id=auth.uid()))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR
         (public.has_role(auth.uid(),'anotator') AND annotator_id=auth.uid()));
CREATE POLICY table_cells_translate ON public.table_cells FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR
         (public.has_role(auth.uid(),'anotator') AND EXISTS (
           SELECT 1 FROM public.tqa_tables t WHERE t.id=table_id AND t.annotator_id=auth.uid())))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR
         (public.has_role(auth.uid(),'anotator') AND EXISTS (
           SELECT 1 FROM public.tqa_tables t WHERE t.id=table_id AND t.annotator_id=auth.uid())));
CREATE POLICY qa_pairs_translate ON public.qa_pairs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR
         (public.has_role(auth.uid(),'anotator') AND annotator_id=auth.uid()))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR
         (public.has_role(auth.uid(),'anotator') AND annotator_id=auth.uid()));

-- Validator may create/update only work explicitly assigned to them. Admin remains unrestricted.
DROP POLICY IF EXISTS table_reviews_insert ON public.table_reviews;
DROP POLICY IF EXISTS table_reviews_update ON public.table_reviews;
DROP POLICY IF EXISTS qa_reviews_insert ON public.qa_reviews;
DROP POLICY IF EXISTS qa_reviews_update ON public.qa_reviews;
CREATE POLICY table_reviews_insert ON public.table_reviews FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(),'admin') OR
    (reviewer_id=auth.uid() AND public.has_role(auth.uid(),'validator') AND EXISTS (
      SELECT 1 FROM public.tqa_tables t WHERE t.id=table_id AND t.validator_id=auth.uid()))
  );
CREATE POLICY table_reviews_update ON public.table_reviews FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR
    (reviewer_id=auth.uid() AND public.has_role(auth.uid(),'validator') AND EXISTS (
      SELECT 1 FROM public.tqa_tables t WHERE t.id=table_id AND t.validator_id=auth.uid())))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR
    (reviewer_id=auth.uid() AND public.has_role(auth.uid(),'validator') AND EXISTS (
      SELECT 1 FROM public.tqa_tables t WHERE t.id=table_id AND t.validator_id=auth.uid())));
CREATE POLICY qa_reviews_insert ON public.qa_reviews FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(),'admin') OR
    (reviewer_id=auth.uid() AND public.has_role(auth.uid(),'validator') AND EXISTS (
      SELECT 1 FROM public.qa_pairs q WHERE q.id=qa_pair_id AND q.validator_id=auth.uid()))
  );
CREATE POLICY qa_reviews_update ON public.qa_reviews FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR
    (reviewer_id=auth.uid() AND public.has_role(auth.uid(),'validator') AND EXISTS (
      SELECT 1 FROM public.qa_pairs q WHERE q.id=qa_pair_id AND q.validator_id=auth.uid())))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR
    (reviewer_id=auth.uid() AND public.has_role(auth.uid(),'validator') AND EXISTS (
      SELECT 1 FROM public.qa_pairs q WHERE q.id=qa_pair_id AND q.validator_id=auth.uid())));

-- Assignment-aware table save RPC (replaces the v3 version).
CREATE OR REPLACE FUNCTION public.hitab_save_table_translation(_table_id uuid,_title text,_cells jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE kv record; changed integer;
BEGIN
  IF NOT (
    public.has_role(auth.uid(),'admin') OR
    (public.has_role(auth.uid(),'anotator') AND EXISTS (
      SELECT 1 FROM public.tqa_tables WHERE id=_table_id AND annotate_flag=1 AND annotator_id=auth.uid()
    ))
  ) THEN RAISE EXCEPTION 'Table is not assigned to this annotator'; END IF;
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

-- Assignment-aware opened-work audit (replaces the v3 version).
CREATE OR REPLACE FUNCTION public.hitab_open_work(_kind text,_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE tid uuid; qid uuid; source_tid text; source_qid text;
BEGIN
  IF _kind='table' THEN
    IF NOT (public.has_role(auth.uid(),'admin') OR EXISTS (
      SELECT 1 FROM public.tqa_tables WHERE id=_id AND annotate_flag=1
        AND annotator_id=auth.uid() AND public.has_role(auth.uid(),'anotator'))) THEN
      RAISE EXCEPTION 'Table not assigned to this annotator'; END IF;
    tid:=_id;
  ELSIF _kind='qa' THEN
    IF NOT (public.has_role(auth.uid(),'admin') OR EXISTS (
      SELECT 1 FROM public.qa_pairs WHERE id=_id AND annotate_flag=1
        AND annotator_id=auth.uid() AND public.has_role(auth.uid(),'anotator'))) THEN
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
  VALUES (auth.uid(),CASE WHEN public.has_role(auth.uid(),'admin') THEN 'admin'
           WHEN _kind IN ('table_review','qa_review') THEN 'validator' ELSE 'anotator' END,
          _kind,tid,qid,source_tid,source_qid,'opened');
END;
$$;

-- 4) Review queues expose only the current validator's assignment; Admin sees every sampled item.
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
      t.title_en table_title_en,t.title_id table_title_id,t.validator_id assigned_validator
    FROM public.tqa_tables t LEFT JOIN public.table_reviews r ON r.table_id=t.id
    WHERE _kind='tabel' AND t.annotate_flag=1
    UNION ALL
    SELECT q.id,t.code,q.question_en,q.question_id,
      (nullif(btrim(q.question_id),'') IS NOT NULL AND nullif(btrim(q.answer_id),'') IS NOT NULL
       AND q.status='selesai'),COALESCE(r.status,'belum_diperiksa'),r.reviewer_id,
      t.title_en,t.title_id,q.validator_id
    FROM public.qa_pairs q JOIN public.tqa_tables t ON t.id=q.table_id
      LEFT JOIN public.qa_reviews r ON r.qa_pair_id=q.id
    WHERE _kind='pertanyaan' AND q.annotate_flag=1
  ), filtered AS (
    SELECT * FROM all_items WHERE (_search='' OR table_code ILIKE '%'||_search||'%'
      OR source_text ILIKE '%'||_search||'%' OR translated_text ILIKE '%'||_search||'%'
      OR table_title_en ILIKE '%'||_search||'%' OR table_title_id ILIKE '%'||_search||'%')
      AND (_status='semua' OR review_status=_status)
      AND (public.has_role(auth.uid(),'admin') OR
           (public.has_role(auth.uid(),'validator') AND assigned_validator=auth.uid()))
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
      t.title_en source_text,t.title_id translated_text,t.validator_id assigned_validator
    FROM public.tqa_tables t LEFT JOIN public.table_reviews r ON r.table_id=t.id
    WHERE _kind='tabel' AND t.annotate_flag=1
    UNION ALL
    SELECT t.code,t.title_en,t.title_id,COALESCE(r.status,'belum_diperiksa'),q.question_en,q.question_id,q.validator_id
    FROM public.qa_pairs q JOIN public.tqa_tables t ON t.id=q.table_id
      LEFT JOIN public.qa_reviews r ON r.qa_pair_id=q.id
    WHERE _kind='pertanyaan' AND q.annotate_flag=1
  ) x WHERE (_search='' OR x.code ILIKE '%'||_search||'%'
    OR x.source_text ILIKE '%'||_search||'%' OR x.translated_text ILIKE '%'||_search||'%'
    OR x.title_en ILIKE '%'||_search||'%' OR x.title_id ILIKE '%'||_search||'%')
    AND (public.has_role(auth.uid(),'admin') OR
         (public.has_role(auth.uid(),'validator') AND x.assigned_validator=auth.uid()));
$$;

COMMIT;
