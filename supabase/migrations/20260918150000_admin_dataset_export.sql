-- IndoHiTAB v5: admin-only, paginated exports in the original HiTAB shapes.
-- Apply AFTER v3 + v4. Additive: no table data or existing functions modified.
-- Admin verification is enforced by PostgreSQL, not only the React menu.
BEGIN;

CREATE FUNCTION public.hitab_export_page(
  _kind text, _stage text DEFAULT 'current', _sample_only boolean DEFAULT true,
  _limit integer DEFAULT 100, _offset integer DEFAULT 0
) RETURNS TABLE (
  source_id text, parent_source_id text, dataset_split text,
  annotate_flag integer, work_status text, payload jsonb, total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only Admin may export the research dataset' USING ERRCODE = '42501';
  END IF;
  IF _kind NOT IN ('table', 'qa') OR _kind IS NULL THEN
    RAISE EXCEPTION 'Invalid export kind';
  END IF;
  IF _stage NOT IN ('original', 'current', 'final') OR _stage IS NULL THEN
    RAISE EXCEPTION 'Invalid export stage';
  END IF;
  IF _limit IS NULL OR _limit < 1 OR _limit > 100 OR _offset IS NULL OR _offset < 0 THEN
    RAISE EXCEPTION 'Export page must have 1–100 records and non-negative offset';
  END IF;

  IF _kind = 'table' THEN
    RETURN QUERY
    SELECT t.original_table_id, NULL::text, NULL::text, t.annotate_flag,
      CASE
        WHEN r.status='selesai' AND t.validated_table IS NOT NULL THEN 'validated'
        WHEN r.id IS NOT NULL THEN 'in_review'
        WHEN nullif(btrim(t.title_id),'') IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id)
             AND NOT EXISTS (SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id
                             AND nullif(btrim(c.target_text),'') IS NULL) THEN 'translated'
        WHEN nullif(btrim(t.title_id),'') IS NOT NULL
             OR EXISTS (SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id
                        AND nullif(btrim(c.target_text),'') IS NOT NULL) THEN 'draft'
        ELSE 'unstarted'
      END,
      CASE _stage WHEN 'original' THEN t.original_table
                  WHEN 'final' THEN t.validated_table
                  ELSE COALESCE(t.annotated_table,t.original_table) END,
      count(*) OVER ()
    FROM public.tqa_tables t
    LEFT JOIN public.table_reviews r ON r.table_id=t.id
    WHERE t.original_table_id IS NOT NULL AND t.original_table IS NOT NULL
      AND (NOT _sample_only OR t.annotate_flag=1 OR EXISTS (
        SELECT 1 FROM public.qa_pairs q WHERE q.table_id=t.id AND q.annotate_flag=1
      ))
      AND (_stage <> 'final' OR (r.status='selesai' AND t.validated_table IS NOT NULL))
    ORDER BY t.original_table_id,t.id
    LIMIT _limit OFFSET _offset;
  ELSE
    RETURN QUERY
    SELECT q.original_question_id, t.original_table_id, q.dataset_split, q.annotate_flag,
      CASE
        WHEN r.status='selesai' AND r.logic_confirmed IS TRUE AND q.validated_qa IS NOT NULL THEN 'validated'
        WHEN r.id IS NOT NULL THEN 'in_review'
        WHEN q.status='selesai' AND nullif(btrim(q.question_id),'') IS NOT NULL
             AND nullif(btrim(q.answer_id),'') IS NOT NULL THEN 'translated'
        WHEN nullif(btrim(q.question_id),'') IS NOT NULL OR nullif(btrim(q.answer_id),'') IS NOT NULL THEN 'draft'
        ELSE 'unstarted'
      END,
      CASE _stage WHEN 'original' THEN q.original_qa
                  WHEN 'final' THEN q.validated_qa
                  ELSE COALESCE(q.annotated_qa,q.original_qa) END,
      count(*) OVER ()
    FROM public.qa_pairs q
    JOIN public.tqa_tables t ON t.id=q.table_id
    LEFT JOIN public.qa_reviews r ON r.qa_pair_id=q.id
    LEFT JOIN public.table_reviews tr ON tr.table_id=t.id
    WHERE q.original_question_id IS NOT NULL AND q.original_qa IS NOT NULL
      AND t.original_table_id IS NOT NULL AND t.original_table IS NOT NULL
      AND (NOT _sample_only OR q.annotate_flag=1)
      AND (_stage <> 'final' OR (
        r.status='selesai' AND r.logic_confirmed IS TRUE AND q.validated_qa IS NOT NULL
        AND tr.status='selesai' AND t.validated_table IS NOT NULL
      ))
    ORDER BY q.original_question_id,q.id
    LIMIT _limit OFFSET _offset;
  END IF;
END;
$$;

CREATE FUNCTION public.hitab_export_summary(_sample_only boolean DEFAULT true)
RETURNS TABLE (
  tables_current bigint, qa_current bigint, tables_final bigint, qa_final bigint,
  tables_missing_source bigint, qa_missing_source bigint, qa_waiting_for_table_final bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only Admin may export the research dataset' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT
    (SELECT count(*) FROM public.tqa_tables t
      WHERE t.original_table_id IS NOT NULL AND t.original_table IS NOT NULL
        AND (NOT _sample_only OR t.annotate_flag=1 OR EXISTS (
          SELECT 1 FROM public.qa_pairs q WHERE q.table_id=t.id AND q.annotate_flag=1))),
    (SELECT count(*) FROM public.qa_pairs q JOIN public.tqa_tables t ON t.id=q.table_id
      WHERE q.original_question_id IS NOT NULL AND q.original_qa IS NOT NULL
        AND t.original_table_id IS NOT NULL AND t.original_table IS NOT NULL
        AND (NOT _sample_only OR q.annotate_flag=1)),
    (SELECT count(*) FROM public.tqa_tables t JOIN public.table_reviews r ON r.table_id=t.id
      WHERE t.original_table_id IS NOT NULL AND t.original_table IS NOT NULL
        AND r.status='selesai' AND t.validated_table IS NOT NULL
        AND (NOT _sample_only OR t.annotate_flag=1 OR EXISTS (
          SELECT 1 FROM public.qa_pairs q WHERE q.table_id=t.id AND q.annotate_flag=1))),
    (SELECT count(*) FROM public.qa_pairs q JOIN public.tqa_tables t ON t.id=q.table_id
      JOIN public.qa_reviews r ON r.qa_pair_id=q.id
      JOIN public.table_reviews tr ON tr.table_id=t.id
      WHERE q.original_question_id IS NOT NULL AND q.original_qa IS NOT NULL
        AND t.original_table_id IS NOT NULL AND t.original_table IS NOT NULL
        AND (NOT _sample_only OR q.annotate_flag=1)
        AND r.status='selesai' AND r.logic_confirmed IS TRUE AND q.validated_qa IS NOT NULL
        AND tr.status='selesai' AND t.validated_table IS NOT NULL),
    (SELECT count(*) FROM public.tqa_tables t
      WHERE (NOT _sample_only OR t.annotate_flag=1)
        AND (t.original_table_id IS NULL OR t.original_table IS NULL)),
    (SELECT count(*) FROM public.qa_pairs q JOIN public.tqa_tables t ON t.id=q.table_id
      WHERE (NOT _sample_only OR q.annotate_flag=1)
        AND (q.original_question_id IS NULL OR q.original_qa IS NULL
             OR t.original_table_id IS NULL OR t.original_table IS NULL)),
    (SELECT count(*) FROM public.qa_pairs q JOIN public.tqa_tables t ON t.id=q.table_id
      JOIN public.qa_reviews r ON r.qa_pair_id=q.id
      LEFT JOIN public.table_reviews tr ON tr.table_id=t.id
      WHERE q.original_question_id IS NOT NULL AND q.original_qa IS NOT NULL
        AND t.original_table_id IS NOT NULL AND t.original_table IS NOT NULL
        AND (NOT _sample_only OR q.annotate_flag=1)
        AND r.status='selesai' AND r.logic_confirmed IS TRUE AND q.validated_qa IS NOT NULL
        AND NOT (tr.status='selesai' AND t.validated_table IS NOT NULL));
END;
$$;

REVOKE ALL ON FUNCTION public.hitab_export_page(text,text,boolean,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.hitab_export_summary(boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hitab_export_page(text,text,boolean,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hitab_export_summary(boolean) TO authenticated;
COMMIT;
