import io
import json
import pathlib
import sys
import unittest
import uuid
import zipfile

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import import_hitab as importer

class ImporterTests(unittest.TestCase):
    def setUp(self):
        self.original={
          'title':'Example',
          'texts':[['Year','2024',''],['','Women','Men'],['Jakarta',23,24]],
          'top_root':{'row_index':-1,'column_index':-1,'children':[]},
          'left_root':{'row_index':-1,'column_index':-1,'children':[]},
          'merged_regions':[{'first_row':0,'last_row':0,'first_column':1,'last_column':2}],
          'top_header_rows_num':2,'left_header_columns_num':1,
        }
        self.qa={'id':'qa-A','table_id':'t-A','question':'How many?',
                 'answer':[23.0],'aggregation':['sum'],'answer_formulas':['=B3'],
                 'reference_cells_map':{'B3':'(2, 1)'},'linked_cells':{'quantity_link':{}}}
        out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as z:
            z.writestr('upload_hitab_v2/table/t-A.json',json.dumps(self.original))
            z.writestr('upload_hitab_v2/qa/train_v2.jsonl',json.dumps(self.qa)+'\n')
        self.path=pathlib.Path('/mnt/data')/'_hitab_test_fixture.zip'
        self.path.write_bytes(out.getvalue())

    def tearDown(self):
        self.path.unlink(missing_ok=True)

    def test_stable_uuids_and_independent_sampling(self):
        tables,qa=importer.read_zip(self.path)
        table=list(importer.prepare_tables(tables,{'t-A'}))[0]
        pair=list(importer.prepare_qa(qa,{'t-A'}))[0]
        self.assertEqual(table['annotate_flag'],1)
        self.assertEqual(pair['annotate_flag'],1)
        self.assertEqual(table['original_table_id'],'t-A')
        self.assertEqual(pair['original_question_id'],'qa-A')
        self.assertEqual(pair['table_id'],table['id'])
        self.assertEqual(uuid.UUID(table['id']),uuid.UUID(importer.stable('table','t-A')))

    def test_preserves_original_hierarchy_and_qa_reasoning(self):
        tables,qa=importer.read_zip(self.path)
        table=list(importer.prepare_tables(tables,{'t-A'}))[0]
        pair=list(importer.prepare_qa(qa,{'t-A'}))[0]
        self.assertEqual(table['original_table'],self.original)
        self.assertEqual(table['annotated_table'],self.original)
        for key in ('answer','aggregation','answer_formulas','reference_cells_map','linked_cells'):
            self.assertEqual(pair['original_qa'][key],self.qa[key])
        self.assertIsInstance(pair['original_qa']['answer'],list)
        self.assertIsInstance(pair['original_qa']['answer'][0],float)

    def test_cell_coordinates_are_not_inferred_from_flat_position(self):
        tables,_=importer.read_zip(self.path)
        cells=list(importer.prepare_cells(tables,{'t-A'}))
        self.assertTrue(all('row_index' in c and 'column_index' in c for c in cells))
        self.assertIn((1,1),{(c['row_index'],c['column_index']) for c in cells})
        self.assertNotIn((2,1),{(c['row_index'],c['column_index']) for c in cells})
        self.assertEqual(len({c['id'] for c in cells}),len(cells))

if __name__=='__main__':unittest.main()
