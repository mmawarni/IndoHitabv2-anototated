-- Verify the replacement main sample and preserved pilot data.

-- Main NSF + ToTTo sample only (exclude independent overlap copies).
SELECT
  ds.code AS source,
  count(DISTINCT t.id) AS tables,
  count(q.id) AS qa
FROM public.tqa_tables t
LEFT JOIN public.hitab_data_sources ds ON ds.id=t.data_source_id
LEFT JOIN public.qa_pairs q
  ON q.table_id=t.id AND q.annotate_flag=1
WHERE t.annotate_flag=1
  AND COALESCE(t.overlap_copy,false)=false
  AND t.data_source_id IN (2,4)
GROUP BY ds.code
ORDER BY ds.code;

-- Historical pilot rows remain present, even when their source is no longer in the main sample.
SELECT
  t.batch_no,
  ds.code AS source,
  count(DISTINCT t.id) AS pilot_tables,
  count(q.id) AS pilot_qa
FROM public.tqa_tables t
LEFT JOIN public.hitab_data_sources ds ON ds.id=t.data_source_id
LEFT JOIN public.qa_pairs q
  ON q.table_id=t.id AND q.annotate_flag=1
WHERE t.is_pilot=true
GROUP BY t.batch_no,ds.code
ORDER BY t.batch_no,ds.code;

-- Main workload by batch, excluding pilot-only historical rows and overlap duplicates.
SELECT
  t.batch_no,
  count(DISTINCT t.id) AS tables,
  count(q.id) AS qa
FROM public.tqa_tables t
LEFT JOIN public.qa_pairs q
  ON q.table_id=t.id AND q.annotate_flag=1
WHERE t.annotate_flag=1
  AND COALESCE(t.overlap_copy,false)=false
  AND t.data_source_id IN (2,4)
GROUP BY t.batch_no
ORDER BY t.batch_no;
