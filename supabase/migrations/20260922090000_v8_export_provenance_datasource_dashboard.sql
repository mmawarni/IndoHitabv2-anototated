-- IndoHiTAB v8: preserve HiTAB v2 export schema, server-issued download audit,
-- role-scoped progress breakdown, and explicit datasource catalog.
-- Prerequisite: migrations through v7.1. Test on staging and take a database backup.
-- No existing original/annotated/validated JSON is rewritten by this migration.
BEGIN;

-- Code 1 is deliberately "nsc" as requested. The uploaded QA actually contains
-- "nsf", "statcan", and "totto"; never silently conflate nsc and nsf.
CREATE TABLE IF NOT EXISTS public.hitab_data_sources (
  id smallint PRIMARY KEY CHECK (id > 0),
  code text NOT NULL UNIQUE CHECK (code = lower(btrim(code)) AND code <> ''),
  label text NOT NULL CHECK (btrim(label) <> '')
);
INSERT INTO public.hitab_data_sources(id,code,label) VALUES
  (1,'nsc','NSC'),
  (2,'nsf','NSF'),
  (3,'statcan','Statistics Canada'),
  (4,'totto','ToTTo')
ON CONFLICT (id) DO NOTHING;
-- Fail rather than accidentally relabel an existing numeric code.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.hitab_data_sources WHERE id=1 AND code <> 'nsc') THEN
    RAISE EXCEPTION 'Datasource code 1 must remain nsc';
  END IF;
END $$;
ALTER TABLE public.hitab_data_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hitab_data_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.hitab_data_sources TO authenticated;
GRANT ALL ON public.hitab_data_sources TO service_role;
DROP POLICY IF EXISTS hitab_data_sources_read ON public.hitab_data_sources;
CREATE POLICY hitab_data_sources_read ON public.hitab_data_sources FOR SELECT TO authenticated
USING (auth.uid() IS NOT NULL);

ALTER TABLE public.tqa_tables ADD COLUMN IF NOT EXISTS data_source_id smallint
  REFERENCES public.hitab_data_sources(id);
ALTER TABLE public.qa_pairs ADD COLUMN IF NOT EXISTS data_source_id smallint
  REFERENCES public.hitab_data_sources(id);
CREATE INDEX IF NOT EXISTS hitab_table_datasource_idx ON public.tqa_tables(data_source_id) WHERE annotate_flag=1;
CREATE INDEX IF NOT EXISTS hitab_qa_datasource_idx ON public.qa_pairs(data_source_id) WHERE annotate_flag=1;

-- Use explicit HiTAB QA table_source labels. Unknown or missing provenance stays NULL.
UPDATE public.qa_pairs q SET data_source_id = s.id
FROM public.hitab_data_sources s
WHERE q.data_source_id IS NULL
  AND s.code = lower(btrim(q.original_qa ->> 'table_source'));
-- Only assign a table when ALL associated source labels agree and are known.
WITH known AS (
  SELECT q.table_id, min(q.data_source_id) AS source_id
  FROM public.qa_pairs q
  GROUP BY q.table_id
  HAVING count(*) FILTER (WHERE q.data_source_id IS NULL) = 0
     AND count(DISTINCT q.data_source_id) = 1
)
UPDATE public.tqa_tables t SET data_source_id = k.source_id
FROM known k WHERE t.id=k.table_id AND t.data_source_id IS NULL;
-- Complete QA with its parent classification only if its original source is absent.
UPDATE public.qa_pairs q SET data_source_id=t.data_source_id
FROM public.tqa_tables t
WHERE q.table_id=t.id AND q.data_source_id IS NULL
  AND t.data_source_id IS NOT NULL
  AND nullif(btrim(q.original_qa ->> 'table_source'),'') IS NULL;

-- Explicit Admin-only correction endpoint: parent + children updated in ONE transaction.
-- Source metadata in original_qa remains untouched for reproducibility.
CREATE FUNCTION public.hitab_set_table_data_source(_original_table_id text,_source_id smallint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE tid uuid; original_source_mismatch boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE='42501';
  END IF;
  IF _source_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.hitab_data_sources WHERE id=_source_id
  ) THEN RAISE EXCEPTION 'Unknown datasource ID %', _source_id; END IF;
  SELECT id INTO tid FROM public.tqa_tables WHERE original_table_id=_original_table_id FOR UPDATE;
  IF tid IS NULL THEN RAISE EXCEPTION 'Unknown original table ID'; END IF;
  -- A declared original QA table_source must not be silently relabelled.
  SELECT EXISTS (
    SELECT 1 FROM public.qa_pairs q
    WHERE q.table_id=tid AND nullif(btrim(q.original_qa ->> 'table_source'),'') IS NOT NULL
      AND (_source_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.hitab_data_sources s
        WHERE s.id=_source_id AND s.code=lower(btrim(q.original_qa ->> 'table_source'))
      ))
  ) INTO original_source_mismatch;
  IF original_source_mismatch THEN
    RAISE EXCEPTION 'Datasource conflicts with original QA table_source; original metadata cannot be relabelled';
  END IF;
  UPDATE public.tqa_tables SET data_source_id=_source_id WHERE id=tid;
  UPDATE public.qa_pairs SET data_source_id=_source_id WHERE table_id=tid;
END;
$$;
REVOKE ALL ON FUNCTION public.hitab_set_table_data_source(text,smallint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hitab_set_table_data_source(text,smallint) TO authenticated;

-- These fields are provenance, not annotator-editable fields; old table-level
-- UPDATE grants are not sufficient protection, so enforce in a trigger too.
CREATE FUNCTION public.hitab_data_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.data_source_id IS DISTINCT FROM OLD.data_source_id
     AND current_user NOT IN ('postgres','service_role')
     AND NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'Only Admin can change the datasource classification' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS hitab_table_data_source_guard ON public.tqa_tables;
CREATE TRIGGER hitab_table_data_source_guard BEFORE UPDATE OF data_source_id ON public.tqa_tables
FOR EACH ROW EXECUTE FUNCTION public.hitab_data_source_guard();
DROP TRIGGER IF EXISTS hitab_qa_data_source_guard ON public.qa_pairs;
CREATE TRIGGER hitab_qa_data_source_guard BEFORE UPDATE OF data_source_id ON public.qa_pairs
FOR EACH ROW EXECUTE FUNCTION public.hitab_data_source_guard();

-- RPC v8 has a new name so the old export function and return signature remain
-- intact until the new React code has been deployed; no DROP FUNCTION required.
CREATE FUNCTION public.hitab_export_page_v8(
  _kind text, _stage text DEFAULT 'current', _sample_only boolean DEFAULT true,
  _limit integer DEFAULT 100, _offset integer DEFAULT 0
) RETURNS TABLE (
  source_id text, parent_source_id text, dataset_split text,
  annotate_flag integer, work_status text, payload jsonb, total_count bigint,
  translated_question text, translated_answer text,
  data_source_id smallint, data_source_code text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'Only Admin may export research data' USING ERRCODE='42501';
  END IF;
  IF _kind IS NULL OR _kind NOT IN ('table','qa') OR _stage IS NULL
     OR _stage NOT IN ('original','current','final') THEN
    RAISE EXCEPTION 'Invalid export selection';
  END IF;
  IF _limit IS NULL OR _limit < 1 OR _limit > 100 OR _offset IS NULL OR _offset < 0 THEN
    RAISE EXCEPTION 'Invalid export pagination';
  END IF;
  IF _kind='table' THEN
    RETURN QUERY SELECT t.original_table_id, NULL::text, NULL::text, t.annotate_flag,
      CASE WHEN r.status='selesai' AND t.validated_table IS NOT NULL THEN 'validated'
        WHEN r.id IS NOT NULL THEN 'in_review'
        WHEN nullif(btrim(t.title_id),'') IS NOT NULL
          AND EXISTS(SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id)
          AND NOT EXISTS(SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id
                           AND nullif(btrim(c.target_text),'') IS NULL) THEN 'translated'
        WHEN nullif(btrim(t.title_id),'') IS NOT NULL
          OR EXISTS(SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id
                    AND nullif(btrim(c.target_text),'') IS NOT NULL) THEN 'draft'
        ELSE 'unstarted' END,
      CASE _stage WHEN 'original' THEN t.original_table
        WHEN 'final' THEN t.validated_table ELSE COALESCE(t.annotated_table,t.original_table) END,
      count(*) OVER (), NULL::text,NULL::text,t.data_source_id,s.code
    FROM public.tqa_tables t
    LEFT JOIN public.table_reviews r ON r.table_id=t.id
    LEFT JOIN public.hitab_data_sources s ON s.id=t.data_source_id
    WHERE t.original_table_id IS NOT NULL AND t.original_table IS NOT NULL
      AND (NOT _sample_only OR t.annotate_flag=1 OR EXISTS (
        SELECT 1 FROM public.qa_pairs q WHERE q.table_id=t.id AND q.annotate_flag=1))
      AND (_stage <> 'final' OR (r.status='selesai' AND t.validated_table IS NOT NULL))
    ORDER BY t.original_table_id,t.id LIMIT _limit OFFSET _offset;
  ELSE
    RETURN QUERY SELECT q.original_question_id,t.original_table_id,q.dataset_split,q.annotate_flag,
      CASE WHEN r.status='selesai' AND r.logic_confirmed AND q.validated_qa IS NOT NULL THEN 'validated'
        WHEN r.id IS NOT NULL THEN 'in_review'
        WHEN q.status='selesai' AND nullif(btrim(q.question_id),'') IS NOT NULL
          AND nullif(btrim(q.answer_id),'') IS NOT NULL THEN 'translated'
        WHEN nullif(btrim(q.question_id),'') IS NOT NULL OR nullif(btrim(q.answer_id),'') IS NOT NULL THEN 'draft'
        ELSE 'unstarted' END,
      -- Canonical source QA is preserved. Translation is exported as separate
      -- columns, NEVER as additional source-schema keys in the QA JSONL.
      q.original_qa,count(*) OVER (),
      CASE _stage WHEN 'original' THEN NULL::text WHEN 'final' THEN r.reviewed_question_id
        ELSE q.question_id END,
      CASE _stage WHEN 'original' THEN NULL::text WHEN 'final' THEN r.reviewed_answer_id
        ELSE q.answer_id END,
      COALESCE(q.data_source_id,t.data_source_id),s.code
    FROM public.qa_pairs q
    JOIN public.tqa_tables t ON t.id=q.table_id
    LEFT JOIN public.qa_reviews r ON r.qa_pair_id=q.id
    LEFT JOIN public.table_reviews tr ON tr.table_id=t.id
    LEFT JOIN public.hitab_data_sources s ON s.id=COALESCE(q.data_source_id,t.data_source_id)
    WHERE q.original_question_id IS NOT NULL AND q.original_qa IS NOT NULL
      AND t.original_table_id IS NOT NULL AND t.original_table IS NOT NULL
      AND (NOT _sample_only OR q.annotate_flag=1)
      AND (_stage <> 'final' OR (r.status='selesai' AND r.logic_confirmed
        AND q.validated_qa IS NOT NULL AND tr.status='selesai' AND t.validated_table IS NOT NULL))
    ORDER BY q.original_question_id,q.id LIMIT _limit OFFSET _offset;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.hitab_export_page_v8(text,text,boolean,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hitab_export_page_v8(text,text,boolean,integer,integer) TO authenticated;

-- Server clock is authoritative. This log records an export REQUEST, not proof
-- that a browser actually received or stored the ZIP file.
CREATE TABLE public.hitab_dataset_download_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL, -- pseudonymous provenance survives account deletion without blocking deletion
  stage text NOT NULL CHECK(stage IN ('original','current','final')),
  sampled_only boolean NOT NULL,
  table_count integer NOT NULL CHECK(table_count>=0),
  qa_count integer NOT NULL CHECK(qa_count>=0),
  event_type text NOT NULL DEFAULT 'download_requested'
    CHECK(event_type='download_requested'),
  date_download timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX hitab_download_log_time_idx ON public.hitab_dataset_download_log(date_download DESC);
ALTER TABLE public.hitab_dataset_download_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hitab_dataset_download_log FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.hitab_dataset_download_log TO authenticated;
GRANT ALL ON public.hitab_dataset_download_log TO service_role;
CREATE POLICY hitab_download_log_admin_read ON public.hitab_dataset_download_log
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));
CREATE FUNCTION public.hitab_register_download_v8(
  _stage text,_sample_only boolean,_tables integer,_qa integer
) RETURNS TABLE (export_id uuid,date_download timestamptz,server_time timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE='42501';
  END IF;
  IF _stage IS NULL OR _stage NOT IN ('original','current','final')
    OR _sample_only IS NULL OR _tables IS NULL OR _qa IS NULL
    OR _tables<0 OR _qa<0 THEN RAISE EXCEPTION 'Invalid export audit metadata'; END IF;
  RETURN QUERY INSERT INTO public.hitab_dataset_download_log AS dl(actor_id,stage,sampled_only,table_count,qa_count)
    VALUES (auth.uid(),_stage,_sample_only,_tables,_qa)
    RETURNING dl.id,dl.date_download,dl.date_download;
END;
$$;
REVOKE ALL ON FUNCTION public.hitab_register_download_v8(text,boolean,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hitab_register_download_v8(text,boolean,integer,integer) TO authenticated;

-- Tables and QA are independently sampled. "Current" means NOT DONE,
-- including untouched assignments. Annotator DONE=translation complete;
-- Admin/Validator DONE=validated (QA requires final parent and confirmed logic).
CREATE FUNCTION public.hitab_dashboard_breakdown_v8()
RETURNS TABLE (
  data_source_id smallint,data_source_code text,data_source_name text,
  tables_all bigint,tables_current bigint,tables_done bigint,
  qa_all bigint,qa_current bigint,qa_done bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
WITH access AS (
 SELECT auth.uid() AS uid,
   EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.status='aktif') AS active,
   (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'validator')) AS global_view,
   public.hitab_validate_assignee(auth.uid(),'anotator') AS worker
), t_scope AS (
 SELECT t.id,t.data_source_id,
  CASE WHEN a.global_view THEN
    (tr.status='selesai' AND t.validated_table IS NOT NULL)
  ELSE (nullif(btrim(t.title_id),'') IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM public.table_cells c WHERE c.table_id=t.id
      AND nullif(btrim(c.target_text),'') IS NULL)) END AS done
 FROM public.tqa_tables t CROSS JOIN access a
 LEFT JOIN public.table_reviews tr ON tr.table_id=t.id
 WHERE a.active AND t.annotate_flag=1
   AND (a.global_view OR (a.worker AND t.annotator_id=a.uid))
), q_scope AS (
 SELECT q.id,COALESCE(q.data_source_id,t.data_source_id) AS data_source_id,
  CASE WHEN a.global_view THEN
    (qr.status='selesai' AND qr.logic_confirmed IS TRUE AND q.validated_qa IS NOT NULL
     AND tr.status='selesai' AND t.validated_table IS NOT NULL)
  ELSE (q.status='selesai' AND nullif(btrim(q.question_id),'') IS NOT NULL
     AND nullif(btrim(q.answer_id),'') IS NOT NULL) END AS done
 FROM public.qa_pairs q
 JOIN public.tqa_tables t ON t.id=q.table_id
 CROSS JOIN access a
 LEFT JOIN public.qa_reviews qr ON qr.qa_pair_id=q.id
 LEFT JOIN public.table_reviews tr ON tr.table_id=t.id
 WHERE a.active AND q.annotate_flag=1
   AND (a.global_view OR (a.worker AND q.annotator_id=a.uid))
), sources AS (
 SELECT data_source_id FROM t_scope UNION SELECT data_source_id FROM q_scope
), t_counts AS (
 SELECT data_source_id,count(*) AS n,count(*) FILTER (WHERE done IS TRUE) AS done
 FROM t_scope GROUP BY data_source_id
), q_counts AS (
 SELECT data_source_id,count(*) AS n,count(*) FILTER (WHERE done IS TRUE) AS done
 FROM q_scope GROUP BY data_source_id
), breakdown AS (
 SELECT s.data_source_id,COALESCE(d.code,'unknown') AS code,
   COALESCE(d.label,'Belum diketahui') AS name,
   COALESCE(tc.n,0)::bigint AS nt, COALESCE(tc.done,0)::bigint AS dt,
   COALESCE(qc.n,0)::bigint AS nq,COALESCE(qc.done,0)::bigint AS dq
 FROM sources s LEFT JOIN public.hitab_data_sources d ON d.id=s.data_source_id
 LEFT JOIN t_counts tc ON tc.data_source_id IS NOT DISTINCT FROM s.data_source_id
 LEFT JOIN q_counts qc ON qc.data_source_id IS NOT DISTINCT FROM s.data_source_id
)
SELECT NULL::smallint,'all'::text,'Semua sumber'::text,
 COALESCE(sum(nt),0)::bigint,(COALESCE(sum(nt),0)-COALESCE(sum(dt),0))::bigint,COALESCE(sum(dt),0)::bigint,
 COALESCE(sum(nq),0)::bigint,(COALESCE(sum(nq),0)-COALESCE(sum(dq),0))::bigint,COALESCE(sum(dq),0)::bigint
FROM breakdown
UNION ALL
SELECT data_source_id,code,name,nt,nt-dt,dt,nq,nq-dq,dq FROM breakdown;
$$;
REVOKE ALL ON FUNCTION public.hitab_dashboard_breakdown_v8() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hitab_dashboard_breakdown_v8() TO authenticated;
COMMIT;
