-- IndoHiTAB replacement overlap
-- Main sample must already be: all NSF + all ToTTo.
-- Selection unit = TABLE. Every sampled QA under the selected table follows it.
--
-- 4 paired overlap groups:
-- G1: B1->B2 13, B2->B1 12 = 25 unique tables
-- G2: B3->B4 12, B4->B3 13 = 25
-- G3: B5->B6 13, B6->B5 12 = 25
-- G4: B7->B8 12, B8->B7 13 = 25
-- TOTAL = 100 unique source tables / 100 independent duplicate instances.
--
-- SAFETY: if an older overlap duplicate already contains translated work,
-- this script aborts instead of deleting it.

BEGIN;

ALTER TABLE public.tqa_tables
  ADD COLUMN IF NOT EXISTS is_overlap boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overlap_wave integer,
  ADD COLUMN IF NOT EXISTS overlap_group smallint,
  ADD COLUMN IF NOT EXISTS overlap_copy boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overlap_source_table_id uuid
    REFERENCES public.tqa_tables(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS overlap_origin_batch integer,
  ADD COLUMN IF NOT EXISTS overlap_partner_batch integer;

ALTER TABLE public.qa_pairs
  ADD COLUMN IF NOT EXISTS is_overlap boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overlap_wave integer,
  ADD COLUMN IF NOT EXISTS overlap_group smallint,
  ADD COLUMN IF NOT EXISTS overlap_copy boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overlap_source_qa_id uuid
    REFERENCES public.qa_pairs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS overlap_source_table_id uuid
    REFERENCES public.tqa_tables(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS overlap_origin_batch integer,
  ADD COLUMN IF NOT EXISTS overlap_partner_batch integer;

-- Abort if old overlap work has already started.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.tqa_tables t
    WHERE t.overlap_copy = true
      AND nullif(btrim(t.title_id),'') IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.table_cells c
    JOIN public.tqa_tables t ON t.id=c.table_id
    WHERE t.overlap_copy = true
      AND nullif(btrim(c.target_text),'') IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.qa_pairs q
    WHERE q.overlap_copy = true
      AND (
        nullif(btrim(q.question_id),'') IS NOT NULL
        OR nullif(btrim(q.answer_id),'') IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Old overlap duplicate already contains translation work. Stop and preserve it before replacing overlap.';
  END IF;
END $$;

-- Remove only old duplicate overlap instances that have never been translated.
DELETE FROM public.qa_reviews r
USING public.qa_pairs q
WHERE r.qa_pair_id=q.id
  AND q.overlap_copy=true;

DELETE FROM public.table_reviews r
USING public.tqa_tables t
WHERE r.table_id=t.id
  AND t.overlap_copy=true;

DELETE FROM public.qa_pairs
WHERE overlap_copy=true;

DELETE FROM public.table_cells c
USING public.tqa_tables t
WHERE c.table_id=t.id
  AND t.overlap_copy=true;

DELETE FROM public.tqa_tables
WHERE overlap_copy=true;

-- Clear old overlap flags on canonical/original rows.
UPDATE public.qa_pairs
SET
  is_overlap=false,
  overlap_wave=NULL,
  overlap_group=NULL,
  overlap_copy=false,
  overlap_source_qa_id=NULL,
  overlap_source_table_id=NULL,
  overlap_origin_batch=NULL,
  overlap_partner_batch=NULL
WHERE overlap_copy=false
  AND is_overlap=true;

UPDATE public.tqa_tables
SET
  is_overlap=false,
  overlap_wave=NULL,
  overlap_group=NULL,
  overlap_copy=false,
  overlap_source_table_id=NULL,
  overlap_origin_batch=NULL,
  overlap_partner_batch=NULL
WHERE overlap_copy=false
  AND is_overlap=true;

CREATE UNIQUE INDEX IF NOT EXISTS tqa_tables_overlap_source_wave_uq
  ON public.tqa_tables(overlap_source_table_id, overlap_wave)
  WHERE overlap_copy=true AND overlap_source_table_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS qa_pairs_overlap_source_wave_uq
  ON public.qa_pairs(overlap_source_qa_id, overlap_wave)
  WHERE overlap_copy=true AND overlap_source_qa_id IS NOT NULL;

CREATE TEMP TABLE _overlap_plan (
  overlap_group smallint NOT NULL,
  source_batch integer NOT NULL,
  target_batch integer NOT NULL,
  take_n integer NOT NULL
) ON COMMIT DROP;

INSERT INTO _overlap_plan VALUES
  (1,1,2,13),
  (1,2,1,12),
  (2,3,4,12),
  (2,4,3,13),
  (3,5,6,13),
  (3,6,5,12),
  (4,7,8,12),
  (4,8,7,13);

-- Source selection is restricted to active MAIN NSF/ToTTo rows and excludes pilot.
CREATE TEMP TABLE _overlap_selected ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    p.overlap_group,
    p.source_batch,
    p.target_batch,
    p.take_n,
    t.id AS source_table_id,
    row_number() OVER (
      PARTITION BY p.source_batch
      ORDER BY md5(COALESCE(t.original_table_id,t.id::text) || ':all-totto-nsf-overlap-v1')
    ) AS rn
  FROM _overlap_plan p
  JOIN public.tqa_tables t
    ON t.batch_no=p.source_batch
   AND t.annotate_flag=1
   AND COALESCE(t.is_pilot,false)=false
   AND COALESCE(t.overlap_copy,false)=false
   AND t.data_source_id IN (2,4) -- NSF / ToTTo only
   AND t.original_table_id IS NOT NULL
)
SELECT overlap_group,source_batch,target_batch,source_table_id
FROM ranked
WHERE rn<=take_n;

DO $$
BEGIN
  IF (SELECT count(*) FROM _overlap_selected) <> 100 THEN
    RAISE EXCEPTION 'Expected 100 overlap source tables, found %',
      (SELECT count(*) FROM _overlap_selected);
  END IF;

  IF EXISTS (
    SELECT overlap_group
    FROM _overlap_selected
    GROUP BY overlap_group
    HAVING count(*)<>25
  ) THEN
    RAISE EXCEPTION 'Each overlap pair must contain exactly 25 unique tables';
  END IF;
END $$;

-- Infer current assigned workers for each target batch.
CREATE TEMP TABLE _target_worker ON COMMIT DROP AS
WITH counts AS (
  SELECT
    batch_no,
    annotator_id,
    validator_id,
    count(*) n
  FROM public.tqa_tables
  WHERE batch_no BETWEEN 1 AND 8
    AND annotate_flag=1
    AND COALESCE(overlap_copy,false)=false
  GROUP BY batch_no,annotator_id,validator_id
),
ranked AS (
  SELECT *,
    row_number() OVER (
      PARTITION BY batch_no
      ORDER BY n DESC, annotator_id NULLS LAST
    ) rn
  FROM counts
)
SELECT batch_no,annotator_id,validator_id
FROM ranked
WHERE rn=1;

-- Mark source instances.
UPDATE public.tqa_tables t
SET
  is_overlap=true,
  overlap_wave=1,
  overlap_group=s.overlap_group,
  overlap_copy=false,
  overlap_source_table_id=NULL,
  overlap_origin_batch=s.source_batch,
  overlap_partner_batch=s.target_batch
FROM _overlap_selected s
WHERE t.id=s.source_table_id;

UPDATE public.qa_pairs q
SET
  is_overlap=true,
  overlap_wave=1,
  overlap_group=s.overlap_group,
  overlap_copy=false,
  overlap_source_qa_id=NULL,
  overlap_source_table_id=NULL,
  overlap_origin_batch=s.source_batch,
  overlap_partner_batch=s.target_batch
FROM _overlap_selected s
WHERE q.table_id=s.source_table_id
  AND q.annotate_flag=1;

-- Duplicate tables as clean independent annotation instances.
INSERT INTO public.tqa_tables (
  data_source_id,batch_no,is_pilot,
  original_table_id,original_table,annotated_table,validated_table,
  annotate_flag,annotator_id,validator_id,assigned_to,
  code,created_at,id,title_en,title_id,
  is_overlap,overlap_wave,overlap_group,overlap_copy,
  overlap_source_table_id,overlap_origin_batch,overlap_partner_batch
)
SELECT
  src.data_source_id,
  s.target_batch,
  false,
  src.original_table_id || '__ovl_b' || s.target_batch::text,
  src.original_table,
  NULL,
  NULL,
  1,
  w.annotator_id,
  w.validator_id,
  w.annotator_id,
  src.code || ':ovl-b' || s.target_batch::text,
  now(),
  gen_random_uuid(),
  src.title_en,
  NULL,
  true,1,s.overlap_group,true,
  src.id,s.source_batch,s.target_batch
FROM _overlap_selected s
JOIN public.tqa_tables src ON src.id=s.source_table_id
LEFT JOIN _target_worker w ON w.batch_no=s.target_batch;

-- Duplicate every translatable cell, blank Indonesian target.
INSERT INTO public.table_cells (
  row_index,column_index,id,kind,position,source_text,status,
  table_id,target_text,updated_at,updated_by
)
SELECT
  c.row_index,c.column_index,gen_random_uuid(),c.kind,c.position,c.source_text,'draft',
  dup.id,NULL,now(),NULL
FROM _overlap_selected s
JOIN public.tqa_tables src ON src.id=s.source_table_id
JOIN public.tqa_tables dup
  ON dup.overlap_copy=true
 AND dup.overlap_wave=1
 AND dup.overlap_source_table_id=src.id
JOIN public.table_cells c ON c.table_id=src.id;

-- Duplicate ALL sampled QA under selected tables. QA itself is not sampled separately.
INSERT INTO public.qa_pairs (
  data_source_id,batch_no,is_pilot,
  original_question_id,original_qa,annotated_qa,validated_qa,dataset_split,
  annotate_flag,annotator_id,validator_id,
  answer_en,answer_id,id,position,question_en,question_id,status,
  table_id,updated_at,updated_by,
  is_overlap,overlap_wave,overlap_group,overlap_copy,
  overlap_source_qa_id,overlap_source_table_id,
  overlap_origin_batch,overlap_partner_batch
)
SELECT
  q.data_source_id,
  s.target_batch,
  false,
  q.original_question_id || '__ovl_b' || s.target_batch::text,
  q.original_qa,
  NULL,
  NULL,
  q.dataset_split,
  1,
  dup.annotator_id,
  dup.validator_id,
  q.answer_en,
  NULL,
  gen_random_uuid(),
  q.position,
  q.question_en,
  NULL,
  'draft',
  dup.id,
  now(),
  NULL,
  true,1,s.overlap_group,true,
  q.id,src.id,s.source_batch,s.target_batch
FROM _overlap_selected s
JOIN public.tqa_tables src ON src.id=s.source_table_id
JOIN public.tqa_tables dup
  ON dup.overlap_copy=true
 AND dup.overlap_wave=1
 AND dup.overlap_source_table_id=src.id
JOIN public.qa_pairs q
  ON q.table_id=src.id
 AND q.annotate_flag=1;

-- Verify exact table pairing and exact QA duplication.
DO $$
DECLARE
  st integer;
  dt integer;
  sq integer;
  dq integer;
BEGIN
  SELECT count(*) INTO st
  FROM public.tqa_tables
  WHERE is_overlap=true AND overlap_wave=1 AND overlap_copy=false
    AND data_source_id IN (2,4);

  SELECT count(*) INTO dt
  FROM public.tqa_tables
  WHERE is_overlap=true AND overlap_wave=1 AND overlap_copy=true;

  SELECT count(*) INTO sq
  FROM public.qa_pairs
  WHERE is_overlap=true AND overlap_wave=1 AND overlap_copy=false
    AND annotate_flag=1;

  SELECT count(*) INTO dq
  FROM public.qa_pairs
  WHERE is_overlap=true AND overlap_wave=1 AND overlap_copy=true
    AND annotate_flag=1;

  IF st<>100 OR dt<>100 THEN
    RAISE EXCEPTION 'Overlap table count mismatch: source %, duplicate %',st,dt;
  END IF;

  IF sq<>dq THEN
    RAISE EXCEPTION 'Overlap QA count mismatch: source %, duplicate %',sq,dq;
  END IF;
END $$;

COMMIT;

-- Summary
SELECT
  overlap_group,
  overlap_origin_batch AS source_batch,
  overlap_partner_batch AS target_batch,
  count(*) FILTER (WHERE overlap_copy=false) AS source_tables,
  count(*) FILTER (WHERE overlap_copy=true) AS duplicate_tables
FROM public.tqa_tables
WHERE is_overlap=true AND overlap_wave=1
GROUP BY overlap_group,overlap_origin_batch,overlap_partner_batch
ORDER BY overlap_group,source_batch;

SELECT
  count(*) FILTER (WHERE overlap_copy=false) AS unique_source_tables,
  count(*) FILTER (WHERE overlap_copy=true) AS independent_duplicates
FROM public.tqa_tables
WHERE is_overlap=true AND overlap_wave=1;

SELECT
  count(*) FILTER (WHERE overlap_copy=false) AS source_qa,
  count(*) FILTER (WHERE overlap_copy=true) AS duplicate_qa
FROM public.qa_pairs
WHERE is_overlap=true AND overlap_wave=1
  AND annotate_flag=1;
