/** Canonical HiTAB-v2 export: provenance lives OUTSIDE table JSON and QA JSONL. */
export type ExportStage = "original" | "current" | "final";
export type ExportKind = "table" | "qa";
export type ExportStatus = "unstarted" | "draft" | "translated" | "in_review" | "validated";

export interface ExportRow {
  source_id: string;
  parent_source_id: string | null;
  dataset_split: string | null;
  annotate_flag: number;
  work_status: ExportStatus;
  payload: Record<string, unknown>;
  total_count: number;
  translated_question?: string | null;
  translated_answer?: string | null;
  data_source_id?: number | null;
  data_source_code?: string | null;
}
export interface ExportEntry { name: string; contents: string }
export interface ExportReceipt {
  export_id: string;
  date_download: string; // ISO-8601 issued by PostgreSQL, not device clock.
  server_time: string;
}

// Exactly the keys and order found in upload_hitab_v2/qa/{train,test}_v2.jsonl.
// PostgreSQL JSONB does not preserve original object key order; construct the
// canonical record explicitly without changing the values or adding metadata.
const qaFields = [
  "id", "table_id", "table_source", "sentence_id", "sub_sentence_id",
  "sub_sentence", "question", "answer", "aggregation", "linked_cells",
  "answer_formulas", "reference_cells_map",
] as const;
const qaKeys = new Set<string>(qaFields);
const tableFields = ["title", "top_root", "left_root", "texts", "merged_regions", "top_header_rows_num", "left_header_columns_num"] as const;

/** Use the ORIGINAL file basename; percent-encoding changes HiTAB table IDs.
 * A slash/backslash/control character is unsafe as a ZIP path segment: reject it.
 */
export function originalTableFilename(id: string): string {
  if (!id || id === "." || id === ".." || /[\\/\x00-\x1f\x7f]/.test(id)) {
    throw new Error(`Unsafe original HiTAB table ID: ${JSON.stringify(id)}`);
  }
  return `indohitab/table/${id}.json`;
}

export function tableForDownload(row: ExportRow): Record<string, unknown> {
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    throw new Error(`Missing table JSON for ${row.source_id}`);
  }
  const value = structuredClone(row.payload);
  for (const key of tableFields) {
    if (!(key in value)) throw new Error(`Table ${row.source_id} is missing HiTAB-v2 key ${key}`);
  }
  if (!Array.isArray(value.texts) || !Array.isArray(value.merged_regions)) {
    throw new Error(`Table ${row.source_id} has malformed texts or merged_regions`);
  }
  // Retain only canonical schema fields; no download timestamps inside original JSON.
  return Object.fromEntries(tableFields.map((name) => [name, value[name]]));
}

/** Only the singleton textual answer can be mapped safely from one text box.
 * Numeric answers remain typed. Multi-answer text requires per-answer editing,
 * NOT guessing via splitting on commas; report it in status.csv instead.
 */
export function answerTranslationState(row: ExportRow, stage: ExportStage): string {
  if (stage === "original" || !row.translated_answer?.trim()) return "source_preserved";
  const answers = row.payload?.answer;
  if (!Array.isArray(answers) || !answers.length) return "requires_structured_review";
  if (answers.every((item) => typeof item === "number")) return "typed_value_preserved";
  if (answers.length !== 1) return "requires_structured_review";
  return typeof answers[0] === "string" ? "translated_single_text" : "typed_value_preserved";
}

export function qaForDownload(row: ExportRow, stage: ExportStage): Record<string, unknown> {
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    throw new Error(`Missing QA JSON for ${row.source_id}`);
  }
  const value = structuredClone(row.payload);
  if (value.id !== row.source_id || value.table_id !== row.parent_source_id || !Array.isArray(value.answer)) {
    throw new Error(`QA ${row.source_id} has inconsistent ID, table ID, or answer type`);
  }
  // Earlier database snapshots added question_id/answer_id. The v2 schema
  // contains neither; these are only translation workspace fields.
  delete value.question_id;
  delete value.answer_id;
  for (const key of qaFields) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`QA ${row.source_id} is missing source v2 key ${key}`);
    }
  }
  const extra = Object.keys(value).filter((key) => !qaKeys.has(key));
  if (extra.length) {
    throw new Error(`QA ${row.source_id} has unexpected fields: ${extra.join(", ")}; review source schema before export`);
  }
  if (typeof value.question !== "string" || !Array.isArray(value.aggregation) ||
      !Array.isArray(value.answer_formulas) ||
      !value.linked_cells || typeof value.linked_cells !== "object" || Array.isArray(value.linked_cells) ||
      !value.reference_cells_map || typeof value.reference_cells_map !== "object" || Array.isArray(value.reference_cells_map)) {
    throw new Error(`QA ${row.source_id} has malformed HiTAB v2 fields`);
  }
  if (stage !== "original") {
    if (row.translated_question?.trim()) value.question = row.translated_question.trim();
    if (answerTranslationState(row, stage) === "translated_single_text") {
      value.answer = [row.translated_answer!.trim()];
    }
    if (stage === "final" && answerTranslationState(row, stage) === "requires_structured_review") {
      throw new Error(`QA ${row.source_id} has multiple answers; individual answer translations need review before final export`);
    }
    if (stage === "final" && !row.translated_question?.trim()) {
      throw new Error(`QA ${row.source_id} is marked final but has no reviewed Indonesian question`);
    }
    if (stage === "final" && value.answer.length === 1 &&
        typeof value.answer[0] === "string" && !row.translated_answer?.trim()) {
      throw new Error(`QA ${row.source_id} is marked final but has no reviewed Indonesian textual answer`);
    }
  }
  return Object.fromEntries(qaFields.map((field) => [field, value[field]]));
}

export function csvValue(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const safe = /^[=+@\-\t\r]/.test(text) ? "'" + text : text;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function buildExportFiles(
  stage: ExportStage, sampleOnly: boolean, tables: ExportRow[], qa: ExportRow[],
  receipt: ExportReceipt,
): ExportEntry[] {
  if (!receipt.export_id || !Number.isFinite(Date.parse(receipt.server_time)) ||
      !Number.isFinite(Date.parse(receipt.date_download))) {
    throw new Error("Missing valid server-issued download audit receipt");
  }
  const tableIds = new Set(tables.map((table) => table.source_id));
  if (tableIds.size !== tables.length) throw new Error("Duplicate original table IDs in export");
  if (new Set(qa.map((q) => q.source_id)).size !== qa.length) throw new Error("Duplicate original QA IDs in export");
  for (const pair of qa) {
    if (!pair.parent_source_id || !tableIds.has(pair.parent_source_id)) {
      throw new Error(`QA ${pair.source_id} has no table in this export. Nothing was downloaded.`);
    }
  }
  const result: ExportEntry[] = [];
  for (const table of tables) {
    result.push({ name: originalTableFilename(table.source_id), contents: JSON.stringify(tableForDownload(table), null, 2) + "\n" });
  }
  const grouped = new Map<string, string[]>();
  for (const pair of qa) {
    const split = pair.dataset_split;
    if (!split || !["train", "validation", "dev", "test"].includes(split)) {
      // Never fabricate an "unspecified" split in a HiTAB-v2-compatible release.
      throw new Error(`QA ${pair.source_id} lacks its original train/validation/dev/test split`);
    }
    if (!grouped.has(split)) grouped.set(split, []);
    grouped.get(split)!.push(JSON.stringify(qaForDownload(pair, stage)));
  }
  // The uploaded IndoHiTAB v2 has train_v2.jsonl and test_v2.jsonl (no dev).
  // Always include both expected filenames, even when a sampled/final export
  // currently has zero items in one split. Zero items = an empty JSONL file.
  // If another source actually contains dev, preserve it without inventing it.
  for (const split of ["train", "validation", "test", "dev"]) {
    const lines = grouped.get(split) ?? [];
    if (split !== "dev" || lines.length > 0) {
      result.push({ name: `indohitab/qa/${split}_v2.jsonl`, contents: lines.length ? lines.join("\n") + "\n" : "" });
    }
  }
  const csvRows: (string | number | null)[][] = [
    ["kind", "source_id", "table_id", "split", "data_source_id", "data_source_code", "annotate_flag", "work_status", "export_stage", "answer_translation_state"],
    ...tables.map((t): (string | number | null)[] => ["table", t.source_id, t.source_id, null, t.data_source_id ?? null, t.data_source_code ?? null, t.annotate_flag, t.work_status, stage, null]),
    ...qa.map((q): (string | number | null)[] => ["qa", q.source_id, q.parent_source_id, q.dataset_split, q.data_source_id ?? null, q.data_source_code ?? null, q.annotate_flag, q.work_status, stage, answerTranslationState(q, stage)]),
  ];
  result.push({ name: "indohitab/status.csv", contents: csvRows.map((row) => row.map(csvValue).join(",")).join("\r\n") + "\r\n" });
  const downloadLog = {
    export_id: receipt.export_id,
    date_download: receipt.date_download,
    server_time: receipt.server_time,
    event_type: "download_requested",
    note: "PostgreSQL records a download request, not proof of file receipt or an atomic dataset snapshot.",
    export_stage: stage,
    sampled_only: sampleOnly,
    tables: tables.length,
    qa: qa.length,
  };
  result.push({ name: "indohitab/download_log.json", contents: JSON.stringify(downloadLog, null, 2) + "\n" });
  result.push({ name: "indohitab/manifest.json", contents: JSON.stringify({
    export_id: receipt.export_id,
    date_download: receipt.date_download,
    server_time: receipt.server_time,
    export_stage: stage, sampled_only: sampleOnly,
    tables: tables.length, qa: qa.length,
    qa_split_counts: { train: (grouped.get("train") ?? []).length, test: (grouped.get("test") ?? []).length, dev: (grouped.get("dev") ?? []).length },
    multi_answer_qa_needing_review: qa.filter(q => answerTranslationState(q, stage) === "requires_structured_review").length,
    original_format: "IndoHiTAB v2 table/*.json + qa/train_v2.jsonl + qa/test_v2.jsonl; metadata is stored outside the canonical dataset files.",
    notes: [
      "Original objects are never modified. Translated text replaces question and singleton textual answer in canonical QA keys.",
      "Numeric answers and formula/linked-cell supervision retain their original typed structure.",
      "Multiple textual answers are not split from a single translation field: check status.csv.",
      "Current includes unfinished items; final requires completed table/QA reviews and confirmed QA logic.",
      "Reads are paginated live, not one atomic database snapshot. Pause edits before research release.",
      "date_download is PostgreSQL request time, not proof of ZIP receipt by the user.",
    ],
  }, null, 2) + "\n" });
  return result;
}
// ZIP32 STORED (uncompressed) writer, UTF-8 names; avoids adding a dependency.
// CRC32 checksum + central directory are required by ZIP readers.
const utf8 = new TextEncoder();
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u16(view: DataView, offset: number, value: number) { view.setUint16(offset, value, true); }
function u32(view: DataView, offset: number, value: number) { view.setUint32(offset, value >>> 0, true); }
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
export function zipStored(files: ExportEntry[]): Uint8Array {
  if (files.length > 65535) throw new Error("Too many files for ZIP32");
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const file of files) {
    if (seen.has(file.name)) throw new Error(`Duplicate export filename: ${file.name}`);
    seen.add(file.name);
    const name = utf8.encode(file.name);
    const payload = utf8.encode(file.contents);
    if (name.length > 65535 || payload.length > 0xffffffff) throw new Error("ZIP32 size exceeded");
    const crc = crc32(payload);
    const localHeader = new Uint8Array(30 + name.length);
    const l = new DataView(localHeader.buffer);
    u32(l, 0, 0x04034b50); u16(l, 4, 20); u16(l, 6, 0x0800); // UTF-8
    u16(l, 8, 0); // stored
    u32(l, 14, crc); u32(l, 18, payload.length); u32(l, 22, payload.length);
    u16(l, 26, name.length); localHeader.set(name, 30);
    local.push(localHeader, payload);
    const centralHeader = new Uint8Array(46 + name.length);
    const c = new DataView(centralHeader.buffer);
    u32(c, 0, 0x02014b50); u16(c, 4, 20); u16(c, 6, 20);
    u16(c, 8, 0x0800); u16(c, 10, 0); // UTF-8 / stored
    u32(c, 16, crc); u32(c, 20, payload.length); u32(c, 24, payload.length);
    u16(c, 28, name.length); u32(c, 42, offset);
    centralHeader.set(name, 46);
    central.push(centralHeader);
    offset += localHeader.length + payload.length;
    if (offset > 0xffffffff) throw new Error("ZIP32 size exceeded");
  }
  const directory = concat(central);
  if (offset + directory.length > 0xffffffff) throw new Error("ZIP32 size exceeded");
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  u32(e, 0, 0x06054b50); u16(e, 8, files.length); u16(e, 10, files.length);
  u32(e, 12, directory.length); u32(e, 16, offset);
  return concat([...local, directory, end]);
}
