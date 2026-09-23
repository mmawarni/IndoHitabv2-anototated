"""Static guardrails, NOT a SQL migration execution or security penetration test."""
import pathlib
import unittest

root=pathlib.Path(__file__).resolve().parents[1]
sql=(root/'supabase/migrations/20260922090000_v8_export_provenance_datasource_dashboard.sql').read_text()
ui=(root/'src/routes/_authenticated/dasbor.tsx').read_text()
export=(root/'src/routes/_authenticated/ekspor.tsx').read_text()

class V8Contract(unittest.TestCase):
    def test_server_time_and_download_audit_not_client_clock(self):
        for marker in ('hitab_dataset_download_log','clock_timestamp()','auth.uid()',
                       "'download_requested'",'hitab_register_download_v8','Only Admin'):
            self.assertIn(marker,sql)
        self.assertIn('buildExportFiles(stage, sampleOnly, tables, qa, receipt)',export)
        self.assertIn('hitab_register_download_v8',export)
    def test_datasource_catalog_and_unknown_values(self):
        self.assertIn("(1,'nsc','NSC')",sql)
        self.assertIn("(2,'nsf','NSF')",sql)
        self.assertIn('original_qa ->> \'table_source\'',sql)
        self.assertIn("COALESCE(d.code,'unknown')",sql)
        self.assertNotIn('UPDATE public.tqa_tables SET original_table=',sql)
    def test_scoped_dashboard_stat_and_server_side_authorization(self):
        self.assertIn('hitab_dashboard_breakdown_v8',sql)
        self.assertIn('t.annotator_id=a.uid',sql)
        self.assertIn('q.annotator_id=a.uid',sql)
        self.assertIn('a.active AND t.annotate_flag=1',sql)
        self.assertIn('a.active AND q.annotate_flag=1',sql)
        self.assertIn('hitab_dashboard_breakdown_v8',ui)
        for marker in ('tables_current','tables_done','qa_current','qa_done'):
            self.assertIn(marker,ui)

if __name__=='__main__':unittest.main()
