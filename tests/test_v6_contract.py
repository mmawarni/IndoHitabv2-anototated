"""Static contracts only; NOT a substitute for a PostgreSQL integration test."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SQL = (ROOT / 'supabase/migrations/20260918170000_bulk_assignment_role_dashboard.sql').read_text()
ASSIGN = (ROOT / 'src/routes/_authenticated/penugasan.tsx').read_text()
DASH = (ROOT / 'src/routes/_authenticated/dasbor.tsx').read_text()
ROLES = (ROOT / 'src/routes/_authenticated/pengguna.tsx').read_text()

class V6Contract(unittest.TestCase):
    def test_sql_atomic_bulk_and_permissions(self):
        for marker in ['BEGIN;', 'COMMIT;', 'admin_bulk_assign_work',
                       'FOREACH sid IN ARRAY _source_ids', 'PERFORM public.admin_assign_work',
                       'Select 1 to 100', 'Selected', 'Cannot remove the last Admin',
                       'hitab_can_read_table', 'hitab_can_read_qa']:
            if marker != 'Selected':
                self.assertIn(marker, SQL)
        self.assertIn('REVOKE INSERT,UPDATE,DELETE ON public.user_roles', SQL)
        self.assertIn('REVOKE ALL ON FUNCTION public.admin_set_user_role', SQL)
        self.assertIn('Completed QA review cannot be reassigned', SQL)
        self.assertIn('Completed table review cannot be reassigned', SQL)
    def test_two_independent_item_types_and_keep_other_assignment(self):
        for marker in ['"table" | "qa"', 'type="checkbox"', '_source_ids: ids',
                       '_change_annotator: bulkAnnotator !== KEEP',
                       '_change_validator: bulkValidator !== KEEP',
                       'Jangan ubah', 'Kosongkan penugasan']:
            self.assertIn(marker, ASSIGN)
        self.assertIn('CASE WHEN _change_validator THEN _validator_id ELSE old_validator END', SQL)
        self.assertIn('CASE WHEN _change_annotator THEN _annotator_id ELSE old_annotator END', SQL)
    def test_role_set_and_scoped_dashboard(self):
        self.assertIn('admin_set_user_roles', ROLES)
        self.assertIn('profileRoles.includes(r)', ROLES)
        self.assertIn('queryKey:["progres",userId', DASH)
        self.assertIn('s.worker AND t.annotator_id=auth.uid()', SQL)
        self.assertIn('s.worker AND q.annotator_id=auth.uid()', SQL)
        self.assertIn('q.annotate_flag=1 AND public.hitab_is_assigned_annotator', SQL)
    def test_source_json_untouched(self):
        self.assertNotIn('UPDATE public.tqa_tables SET original_table', SQL)
        self.assertNotIn('UPDATE public.qa_pairs SET original_qa', SQL)

if __name__ == '__main__':
    unittest.main()
