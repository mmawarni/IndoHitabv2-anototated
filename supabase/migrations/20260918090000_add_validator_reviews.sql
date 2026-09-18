-- Review data is deliberately separate from translators' source translations.
-- Apply ONCE to the existing Supabase project after taking a backup.

CREATE TABLE public.table_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL UNIQUE REFERENCES public.tqa_tables(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'sedang_diperiksa'
    CHECK (status IN ('sedang_diperiksa', 'selesai')),
  reviewed_title_id text NOT NULL DEFAULT '',
  corrected_cells jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(corrected_cells) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE public.qa_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qa_pair_id uuid NOT NULL UNIQUE REFERENCES public.qa_pairs(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'sedang_diperiksa'
    CHECK (status IN ('sedang_diperiksa', 'selesai')),
  reviewed_question_id text NOT NULL DEFAULT '',
  reviewed_answer_id text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX table_reviews_reviewer_idx ON public.table_reviews (reviewer_id);
CREATE INDEX qa_reviews_reviewer_idx ON public.qa_reviews (reviewer_id);
CREATE INDEX table_cells_table_id_review_idx ON public.table_cells (table_id);
CREATE INDEX qa_pairs_table_id_review_idx ON public.qa_pairs (table_id);

GRANT SELECT, INSERT, UPDATE ON public.table_reviews, public.qa_reviews TO authenticated;
GRANT ALL ON public.table_reviews, public.qa_reviews TO service_role;
ALTER TABLE public.table_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_reviews ENABLE ROW LEVEL SECURITY;

-- Anyone who is a validator or admin can see review progress, but only the
-- assigned reviewer (or an admin) can change that review.
CREATE POLICY table_reviews_read ON public.table_reviews FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'validator') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY table_reviews_insert ON public.table_reviews FOR INSERT TO authenticated
  WITH CHECK (
    reviewer_id = auth.uid()
    AND (public.has_role(auth.uid(), 'validator') OR public.has_role(auth.uid(), 'admin'))
  );
CREATE POLICY table_reviews_update ON public.table_reviews FOR UPDATE TO authenticated
  USING (reviewer_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (
    reviewer_id = auth.uid() OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY qa_reviews_read ON public.qa_reviews FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'validator') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY qa_reviews_insert ON public.qa_reviews FOR INSERT TO authenticated
  WITH CHECK (
    reviewer_id = auth.uid()
    AND (public.has_role(auth.uid(), 'validator') OR public.has_role(auth.uid(), 'admin'))
  );
CREATE POLICY qa_reviews_update ON public.qa_reviews FOR UPDATE TO authenticated
  USING (reviewer_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (
    reviewer_id = auth.uid() OR public.has_role(auth.uid(), 'admin')
  );

-- The original migrations allow any signed-in user to UPDATE translations.
-- Limit translation edits to annotators and admins; validators write reviews only.
DROP POLICY IF EXISTS "tqa_tables_update_workers" ON public.tqa_tables;
DROP POLICY IF EXISTS "table_cells_update_workers" ON public.table_cells;
DROP POLICY IF EXISTS "qa_pairs_update_workers" ON public.qa_pairs;
CREATE POLICY tqa_tables_translate ON public.tqa_tables FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'anotator') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'anotator') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY table_cells_translate ON public.table_cells FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'anotator') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'anotator') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY qa_pairs_translate ON public.qa_pairs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'anotator') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'anotator') OR public.has_role(auth.uid(), 'admin'));

-- Check readiness and completeness on the server, not only in the UI.
CREATE FUNCTION public.check_table_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'selesai' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tqa_tables t
      WHERE t.id = NEW.table_id AND nullif(btrim(t.title_id), '') IS NOT NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM public.table_cells c WHERE c.table_id = NEW.table_id
    ) OR EXISTS (
      SELECT 1 FROM public.table_cells c WHERE c.table_id = NEW.table_id
        AND (nullif(btrim(c.target_text), '') IS NULL OR c.status <> 'selesai')
    ) THEN
      RAISE EXCEPTION 'Terjemahan tabel belum lengkap; pemeriksaan belum dapat diselesaikan.';
    END IF;
    IF nullif(btrim(NEW.reviewed_title_id), '') IS NULL OR EXISTS (
      SELECT 1 FROM public.table_cells c WHERE c.table_id = NEW.table_id
        AND nullif(btrim(NEW.corrected_cells ->> c.id::text), '') IS NULL
    ) THEN
      RAISE EXCEPTION 'Isi seluruh hasil pemeriksaan judul dan sel sebelum menyelesaikan.';
    END IF;
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  ELSE
    NEW.completed_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_table_review_trigger
BEFORE INSERT OR UPDATE ON public.table_reviews
FOR EACH ROW EXECUTE FUNCTION public.check_table_review();

CREATE FUNCTION public.check_qa_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'selesai' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.qa_pairs q WHERE q.id = NEW.qa_pair_id
        AND nullif(btrim(q.question_id), '') IS NOT NULL
        AND nullif(btrim(q.answer_id), '') IS NOT NULL
        AND q.status = 'selesai'
    ) THEN
      RAISE EXCEPTION 'Pertanyaan dan jawaban belum selesai diterjemahkan.';
    END IF;
    IF nullif(btrim(NEW.reviewed_question_id), '') IS NULL OR
       nullif(btrim(NEW.reviewed_answer_id), '') IS NULL THEN
      RAISE EXCEPTION 'Isi hasil pemeriksaan pertanyaan dan jawaban.';
    END IF;
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  ELSE
    NEW.completed_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_qa_review_trigger
BEFORE INSERT OR UPDATE ON public.qa_reviews
FOR EACH ROW EXECUTE FUNCTION public.check_qa_review();

-- If a translator changes previously reviewed content, the review must be
-- revisited; never continue to display a stale review as 'selesai'.
CREATE FUNCTION public.invalidate_table_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  affected_table_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_table_id := OLD.table_id;
  ELSE
    affected_table_id := NEW.table_id;
  END IF;
  UPDATE public.table_reviews SET status = 'sedang_diperiksa', completed_at = NULL
  WHERE table_id = affected_table_id AND status = 'selesai';
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
-- tqa_tables has id instead of table_id, so use a dedicated title trigger.
CREATE FUNCTION public.invalidate_title_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.table_reviews SET status = 'sedang_diperiksa', completed_at = NULL
  WHERE table_id = NEW.id AND status = 'selesai';
  RETURN NEW;
END;
$$;
CREATE TRIGGER title_translation_invalidates_review
AFTER UPDATE OF title_id ON public.tqa_tables
FOR EACH ROW WHEN (OLD.title_id IS DISTINCT FROM NEW.title_id)
EXECUTE FUNCTION public.invalidate_title_review();

CREATE TRIGGER cell_translation_invalidates_review
AFTER UPDATE OF target_text, status ON public.table_cells
FOR EACH ROW WHEN (
  OLD.target_text IS DISTINCT FROM NEW.target_text OR OLD.status IS DISTINCT FROM NEW.status
)
EXECUTE FUNCTION public.invalidate_table_review();
CREATE TRIGGER cell_added_invalidates_review
AFTER INSERT ON public.table_cells
FOR EACH ROW EXECUTE FUNCTION public.invalidate_table_review();
CREATE TRIGGER cell_deleted_invalidates_review
AFTER DELETE ON public.table_cells
FOR EACH ROW EXECUTE FUNCTION public.invalidate_table_review();

CREATE FUNCTION public.invalidate_qa_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.qa_reviews SET status = 'sedang_diperiksa', completed_at = NULL
  WHERE qa_pair_id = NEW.id AND status = 'selesai';
  RETURN NEW;
END;
$$;
CREATE TRIGGER qa_translation_invalidates_review
AFTER UPDATE OF question_id, answer_id, status ON public.qa_pairs
FOR EACH ROW WHEN (
  OLD.question_id IS DISTINCT FROM NEW.question_id OR
  OLD.answer_id IS DISTINCT FROM NEW.answer_id OR
  OLD.status IS DISTINCT FROM NEW.status
)
EXECUTE FUNCTION public.invalidate_qa_review();

-- Server-side search, filtering, pagination (no 1,000-row Supabase REST cap).
CREATE FUNCTION public.review_queue(
  _kind text, _search text DEFAULT '', _status text DEFAULT 'semua',
  _limit integer DEFAULT 20, _offset integer DEFAULT 0
) RETURNS TABLE (
  item_id uuid, table_code text, source_text text, translated_text text,
  is_ready boolean, review_status text, reviewer_id uuid, total_count bigint
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH all_items AS (
    SELECT t.id item_id, t.code table_code, t.title_en source_text,
      t.title_id translated_text,
      (nullif(btrim(t.title_id), '') IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.table_cells c WHERE c.table_id = t.id)
        AND NOT EXISTS (
          SELECT 1 FROM public.table_cells c WHERE c.table_id = t.id
            AND (nullif(btrim(c.target_text), '') IS NULL OR c.status <> 'selesai')
        )) is_ready,
      COALESCE(r.status, 'belum_diperiksa') review_status, r.reviewer_id,
      t.title_en table_title_en, t.title_id table_title_id
    FROM public.tqa_tables t LEFT JOIN public.table_reviews r ON r.table_id = t.id
    WHERE _kind = 'tabel'
    UNION ALL
    SELECT q.id, t.code, q.question_en, q.question_id,
      (nullif(btrim(q.question_id), '') IS NOT NULL
        AND nullif(btrim(q.answer_id), '') IS NOT NULL
        AND q.status = 'selesai'),
      COALESCE(r.status, 'belum_diperiksa'), r.reviewer_id,
      t.title_en, t.title_id
    FROM public.qa_pairs q JOIN public.tqa_tables t ON t.id = q.table_id
      LEFT JOIN public.qa_reviews r ON r.qa_pair_id = q.id
    WHERE _kind = 'pertanyaan'
  ), filtered AS (
    SELECT * FROM all_items
    WHERE (_search = '' OR table_code ILIKE '%' || _search || '%'
      OR source_text ILIKE '%' || _search || '%'
      OR translated_text ILIKE '%' || _search || '%'
      OR table_title_en ILIKE '%' || _search || '%'
      OR table_title_id ILIKE '%' || _search || '%')
      AND (_status = 'semua' OR review_status = _status)
      AND (public.has_role(auth.uid(), 'validator') OR public.has_role(auth.uid(), 'admin'))
  )
  SELECT f.item_id, f.table_code, f.source_text, f.translated_text,
    f.is_ready, f.review_status, f.reviewer_id,
    (SELECT count(*) FROM filtered) total_count
  FROM filtered f ORDER BY f.table_code, f.item_id
  LIMIT LEAST(GREATEST(_limit, 1), 100) OFFSET GREATEST(_offset, 0);
$$;

CREATE FUNCTION public.review_queue_counts(_kind text, _search text DEFAULT '')
RETURNS TABLE (total bigint, belum bigint, sedang bigint, selesai bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT
    count(*),
    count(*) FILTER (WHERE x.status = 'belum_diperiksa'),
    count(*) FILTER (WHERE x.status = 'sedang_diperiksa'),
    count(*) FILTER (WHERE x.status = 'selesai')
  FROM (
    SELECT t.code, t.title_en, t.title_id,
      COALESCE(r.status, 'belum_diperiksa') status, t.title_en source_text, t.title_id translated_text
    FROM public.tqa_tables t LEFT JOIN public.table_reviews r ON r.table_id = t.id
    WHERE _kind = 'tabel'
    UNION ALL
    SELECT t.code, t.title_en, t.title_id,
      COALESCE(r.status, 'belum_diperiksa'), q.question_en, q.question_id
    FROM public.qa_pairs q JOIN public.tqa_tables t ON t.id = q.table_id
    LEFT JOIN public.qa_reviews r ON r.qa_pair_id = q.id
    WHERE _kind = 'pertanyaan'
  ) x
  WHERE (_search = '' OR x.code ILIKE '%' || _search || '%'
    OR x.source_text ILIKE '%' || _search || '%'
    OR x.translated_text ILIKE '%' || _search || '%'
    OR x.title_en ILIKE '%' || _search || '%'
    OR x.title_id ILIKE '%' || _search || '%')
    AND (public.has_role(auth.uid(), 'validator') OR public.has_role(auth.uid(), 'admin'));
$$;

REVOKE ALL ON FUNCTION public.review_queue(text,text,text,integer,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_queue_counts(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_queue(text,text,text,integer,integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_queue_counts(text,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.check_table_review() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_qa_review() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_table_review() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_title_review() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_qa_review() FROM PUBLIC, anon, authenticated;
