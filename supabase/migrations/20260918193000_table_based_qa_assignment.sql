-- IndoHiTAB v7 candidate for the previously shared v6 schema.
-- Run AFTER v6 migration (and test on staging). This does NOT change sampling flags.
-- Table assignment cascades to sampled QA by qa_pairs.table_id; original IDs remain separate.
BEGIN;

CREATE OR REPLACE FUNCTION public.admin_assign_tables_with_qa(
  _source_ids text[],
  _annotator_id uuid DEFAULT NULL,
  _validator_id uuid DEFAULT NULL,
  _change_annotator boolean DEFAULT true,
  _change_validator boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  table_count integer;
  qa_count integer := 0;
  unsampled_count integer := 0;
  qa_item record;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  -- Existing v6 RPC validates 1..100 distinct table IDs, role eligibility,
  -- same-person conflicts, completed reviews, and preserves KEEP choices.
  -- An exception anywhere below rolls back BOTH table and QA changes.
  table_count := public.admin_bulk_assign_work(
    'table', _source_ids, _annotator_id, _validator_id,
    _change_annotator, _change_validator
  );

  SELECT count(*)::integer INTO unsampled_count
    FROM public.qa_pairs q
    JOIN public.tqa_tables t ON t.id = q.table_id
    WHERE t.original_table_id = ANY(_source_ids) AND q.annotate_flag = 0;

  -- Lock sampled QA rows before checking/updating to avoid concurrent changes.
  -- Deterministic UUID ordering also reduces the risk of conflicting lock orders.
  FOR qa_item IN
    SELECT q.id, q.original_question_id,
           q.annotator_id AS current_annotator, q.validator_id AS current_validator,
           t.annotator_id AS wanted_annotator, t.validator_id AS wanted_validator
      FROM public.qa_pairs q
      JOIN public.tqa_tables t ON t.id = q.table_id
      WHERE t.original_table_id = ANY(_source_ids)
        AND q.annotate_flag = 1
      ORDER BY q.id
      FOR UPDATE OF q
  LOOP
    IF qa_item.original_question_id IS NULL OR btrim(qa_item.original_question_id) = '' THEN
      RAISE EXCEPTION 'QA % has no original_question_id; all assignments rolled back', qa_item.id;
    END IF;

    -- Do not silently overwrite independent/manual QA assignments.
    -- A reviewer can only be reassigned using the controlled workflow already
    -- enforced in v6 admin_assign_work; a completed review stays protected.
    IF (qa_item.current_annotator IS NOT NULL
        AND qa_item.current_annotator IS DISTINCT FROM qa_item.wanted_annotator)
      OR (qa_item.current_validator IS NOT NULL
        AND qa_item.current_validator IS DISTINCT FROM qa_item.wanted_validator) THEN
      RAISE EXCEPTION 'QA % has a different existing assignment; no changes saved. Resolve it in the QA tab first.',
        qa_item.original_question_id;
    END IF;

    PERFORM public.admin_assign_work(
      'qa', qa_item.original_question_id,
      qa_item.wanted_annotator, qa_item.wanted_validator
    );
    qa_count := qa_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'tables_assigned', table_count,
    'qa_assigned', qa_count,
    'qa_excluded_by_sampling', unsampled_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_assign_tables_with_qa(text[],uuid,uuid,boolean,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_tables_with_qa(text[],uuid,uuid,boolean,boolean)
  TO authenticated;
COMMIT;
