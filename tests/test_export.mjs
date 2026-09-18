import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExportFiles, qaForDownload, zipStored } from '../src/lib/hitabExport.ts';

const table = {
  source_id: 'federal-2017', parent_source_id: null, dataset_split: null,
  annotate_flag: 1, work_status: 'draft', total_count: 1,
  payload: { title: 'Pengeluaran', top_root: { children: [{row_index:0,column_index:1,children:[]}] },
    left_root: {children:[]}, texts: [['agency','2017'],['defense','49197']], merged_regions: [] },
};
const qa = {
  source_id: 'q/01', parent_source_id: 'federal-2017', dataset_split: 'train',
  annotate_flag: 1, work_status: 'translated', total_count: 1,
  payload: { id: 'q/01', table_id: 'federal-2017', question: 'original question',
    question_id: 'Pertanyaan Indonesia', answer: [49000], answer_id: '49.000',
    aggregation: ['sum'], linked_cells: {'0': [[1,1]]}, answer_formulas: ['=B2'] },
};

test('QA shape and canonical numeric answer stay intact', () => {
  const translated = qaForDownload(qa, 'current');
  assert.equal(translated.question, 'Pertanyaan Indonesia');
  assert.deepEqual(translated.answer, [49000]);
  assert.deepEqual(translated.aggregation, ['sum']);
  assert.deepEqual(translated.linked_cells, {'0': [[1,1]]});
  assert.equal(qa.payload.question, 'original question');
  assert.equal(qaForDownload(qa, 'original').question, 'original question');
});

test('HiTAB-compatible table JSON, split JSONL, status CSV, manifest', () => {
  const files = buildExportFiles('current',true,[table],[qa],'2026-09-18T00:00:00.000Z');
  const names = files.map(f=>f.name);
  assert.ok(names.includes('indohitab/table/federal-2017.json'));
  assert.ok(names.includes('indohitab/qa/train_v2.jsonl'));
  assert.ok(names.includes('indohitab/qa/dev_v2.jsonl'));
  assert.ok(names.includes('indohitab/qa/test_v2.jsonl'));
  assert.ok(names.includes('indohitab/status.csv'));
  const obj=JSON.parse(files.find(f=>f.name.endsWith('/table/federal-2017.json')).contents);
  assert.deepEqual(obj.top_root, table.payload.top_root);
  assert.deepEqual(obj.merged_regions, []);
  const line=JSON.parse(files.find(f=>f.name.endsWith('/qa/train_v2.jsonl')).contents.trim());
  assert.equal(line.table_id, 'federal-2017');
  assert.deepEqual(line.answer,[49000]);
  assert.match(files.find(f=>f.name.endsWith('/status.csv')).contents, /"qa","q\/01","federal-2017"/);
});

test('Reject orphan QA rather than silently exporting broken references', () => {
  assert.throws(()=>buildExportFiles('final',true,[],[qa],new Date().toISOString()),/no table/);
});

test('QA ID mismatch is rejected', () => {
  assert.throws(()=>buildExportFiles('current',true,[table],[{...qa,payload:{...qa.payload,table_id:'wrong'}}],new Date().toISOString()),/inconsistent original IDs/);
});

test('ZIP names protect path components and preserve unicode', () => {
  const modified={...table,source_id:'../../tabél'};
  const entries=buildExportFiles('original',false,[modified],[],'2026-09-18T00:00:00Z');
  assert.ok(entries[0].name.startsWith('indohitab/table/%2E%2E%2F%2E%2E%2F'));
  assert.ok(zipStored(entries).length>100);
});
