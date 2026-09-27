-- Allow the canonical Hugging Face split name "validation".
-- Existing v3 schema only allowed ('train','dev','test'), which caused
-- the final QA import to stop when the first validation row was encountered.

BEGIN;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.qa_pairs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%dataset_split%'
  LOOP
    EXECUTE format('ALTER TABLE public.qa_pairs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.qa_pairs
  ADD CONSTRAINT qa_pairs_dataset_split_check
  CHECK (
    dataset_split IS NULL
    OR dataset_split IN ('train', 'validation', 'dev', 'test')
  );

COMMIT;

-- Verify:
SELECT
  conname,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.qa_pairs'::regclass
  AND contype = 'c'
  AND pg_get_constraintdef(oid) ILIKE '%dataset_split%';
