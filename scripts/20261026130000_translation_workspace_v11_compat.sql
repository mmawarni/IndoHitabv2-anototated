-- Keep translation_workspace_page_v11 callable for app builds deployed before v12.
-- 20261026120000 dropped it, so those builds failed with "Could not find the function".
-- It now forwards to v12 with no status filter.

BEGIN;

CREATE OR REPLACE FUNCTION public.translation_workspace_page_v11(
  _batch integer DEFAULT NULL,
  _pilot_mode text DEFAULT 'all',
  _limit integer DEFAULT 30,
  _offset integer DEFAULT 0
) RETURNS TABLE (
  table_id uuid,
  code text,
  title_en text,
  title_id text,
  batch_no integer,
  is_pilot boolean,
  cells_total bigint,
  cells_done bigint,
  qa_total bigint,
  qa_done bigint,
  total_count bigint
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT v.table_id, v.code, v.title_en, v.title_id, v.batch_no, v.is_pilot,
         v.cells_total, v.cells_done, v.qa_total, v.qa_done, v.total_count
  FROM public.translation_workspace_page_v12(_batch, _pilot_mode, 'all', _limit, _offset) v;
$$;
REVOKE ALL ON FUNCTION public.translation_workspace_page_v11(integer,text,integer,integer)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.translation_workspace_page_v11(integer,text,integer,integer)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
