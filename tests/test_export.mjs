import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExportFiles, qaForDownload, tableForDownload, zipStored, originalTableFilename } from '../src/lib/hitabExport.ts';

const receipt = {export_id:'12345678-aaaa-4abc-bbbb-123456789012', date_download:'2026-09-22T01:45:02.000+00:00', server_time:'2026-09-22T01:45:02.000+00:00'};
const originalTable = {
  title:'Original title', top_root:{row_index:-1,column_index:-1,children:[]},
  left_root:{row_index:-1,column_index:-1,children:[]},
  texts:[['agency','2017'],['defense','49197']], merged_regions:[],top_header_rows_num:1,left_header_columns_num:1,
};
const table = {
  source_id:'federal-2017', parent_source_id:null, dataset_split:null,
  annotate_flag:1, work_status:'draft', total_count:1, data_source_id:2, data_source_code:'nsf',
  payload:{...originalTable,title:'Pengeluaran'},
};
const originalQa = {
  id:'q/01',table_id:'federal-2017',table_source:'nsf',sentence_id:1,sub_sentence_id:'1',sub_sentence:'sample',
  question:'original question',answer:[49000],aggregation:['sum'],linked_cells:{'0':[[1,1]]},
  answer_formulas:['=B2'],reference_cells_map:{B2:'(1, 1)'},
};
const qa = {
  source_id:'q/01',parent_source_id:'federal-2017',dataset_split:'train',
  annotate_flag:1,work_status:'translated',total_count:1,data_source_id:2,data_source_code:'nsf',
  payload:originalQa,translated_question:'Pertanyaan Indonesia',translated_answer:'49.000',
};
const filesFor = (stage,ts=receipt,tsTable=table,tsQa=qa)=>buildExportFiles(stage,true,[tsTable],[tsQa],ts);

test('Canonical original and current numeric QA preserve original v2 keys and typed values', () => {
  const translated=qaForDownload(qa,'current');
  assert.equal(translated.question,'Pertanyaan Indonesia');
  assert.deepEqual(translated.answer,[49000]);
  assert.deepEqual(translated.aggregation,['sum']);
  assert.deepEqual(Object.keys(translated).sort(),Object.keys(originalQa).sort());
  assert.equal(qaForDownload(qa,'original').question,'original question');
  assert.equal(qa.payload.question,'original question');
});

test('Canonical singleton textual QA answer is localized in answer[] without extra keys', () => {
  const item={...qa,payload:{...originalQa,answer:['women']},translated_answer:'perempuan'};
  const exported=qaForDownload(item,'current');
  assert.deepEqual(exported.answer,['perempuan']);
  assert.equal('answer_id' in exported,false);
});

test('Multi-answer textual QA is not silently split; final export must fail', () => {
  const item={...qa,payload:{...originalQa,answer:['a','b']},translated_answer:'a, b'};
  assert.deepEqual(qaForDownload(item,'current').answer,['a','b']);
  assert.throws(()=>qaForDownload(item,'final'),/multiple answers/);
});

test('HiTAB v2 table schema, original filenames, metadata separately and server timestamp', () => {
  const files=filesFor('current');
  const names=files.map(f=>f.name);
  assert.ok(names.includes('indohitab/table/federal-2017.json'));
  assert.ok(names.includes('indohitab/qa/train_v2.jsonl'));
  assert.ok(!names.includes('indohitab/qa/dev_v2.jsonl'));
  const obj=JSON.parse(files.find(f=>f.name.endsWith('/table/federal-2017.json')).contents);
  assert.deepEqual(Object.keys(obj).sort(),Object.keys(originalTable).sort());
  assert.equal(obj.title,'Pengeluaran');
  assert.equal('date_download' in obj,false);
  const line=JSON.parse(files.find(f=>f.name.endsWith('/qa/train_v2.jsonl')).contents.trim());
  assert.deepEqual(Object.keys(line).sort(),Object.keys(originalQa).sort());
  assert.deepEqual(line.answer,[49000]);
  const audit=JSON.parse(files.find(f=>f.name.endsWith('/download_log.json')).contents);
  assert.equal(audit.date_download,receipt.date_download);
  assert.equal(audit.export_id,receipt.export_id);
  assert.match(files.find(f=>f.name.endsWith('/status.csv')).contents,/"2","nsf"/);
});

test('Reject orphan, inconsistent QA IDs, unsafe table filenames, or missing server receipt',()=>{
  assert.throws(()=>buildExportFiles('final',true,[],[qa],receipt),/no table/);
  assert.throws(()=>filesFor('current',receipt,table,{...qa,payload:{...originalQa,table_id:'wrong'}}),/inconsistent ID/);
  assert.throws(()=>originalTableFilename('../../secret'),/Unsafe/);
  assert.throws(()=>filesFor('current',{...receipt,server_time:'invalid'}),/server-issued/);
});

test('ZIP is readable and contains separate audit/manifest files',()=>{
  const data=zipStored(filesFor('original'));
  assert.ok(data.length>100);
  assert.equal(new DataView(data.buffer).getUint32(0,true),0x04034b50);
});
