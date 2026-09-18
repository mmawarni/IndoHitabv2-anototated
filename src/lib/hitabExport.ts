/** Pure export helpers: no Supabase credentials, no npm ZIP dependency. */
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
}
export interface ExportEntry { name: string; contents: string }

const encode = (value: string) => encodeURIComponent(value).replace(/\./g, "%2E");

/** Retain HiTAB answer arrays, numeric values, formulas, linked cells, and IDs.
 * For translated snapshots, map Indonesian question into the canonical `question`
 * field. Keep translated answer text as `answer_id` because changing the typed
 * `answer` array would corrupt numeric and aggregation supervision.
 */
export function qaForDownload(row: ExportRow, stage: ExportStage): Record<string, unknown> {
  const value = structuredClone(row.payload);
  if (stage !== "original") {
    if (typeof value.question_id === "string" && value.question_id.trim()) {
      value.question = value.question_id;
    }
  }
  return value;
}

export function csvValue(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  // Quoting every field prevents CSV injection when opened in a spreadsheet.
  const safe = /^[=+@\-\t\r]/.test(text) ? "'" + text : text;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function buildExportFiles(
  stage: ExportStage, sampleOnly: boolean, tables: ExportRow[], qa: ExportRow[],
  createdAt: string,
): ExportEntry[] {
  const tableIds = new Set(tables.map((table) => table.source_id));
  for (const pair of qa) {
    if (!pair.parent_source_id || !tableIds.has(pair.parent_source_id)) {
      throw new Error(`QA ${pair.source_id} has no table in this export. Nothing was downloaded.`);
    }
    if (pair.payload.table_id !== pair.parent_source_id || pair.payload.id !== pair.source_id) {
      throw new Error(`QA ${pair.source_id} has inconsistent original IDs. Nothing was downloaded.`);
    }
  }
  const prefix = "indohitab/";
  const result: ExportEntry[] = [];
  for (const table of tables) {
    if (!table.source_id || !table.payload || typeof table.payload !== "object") throw new Error("Invalid table export row");
    // One JSON file per table: mirrors the original /table/*.json layout.
    result.push({ name: `${prefix}table/${encode(table.source_id)}.json`, contents: JSON.stringify(table.payload, null, 2) + "\n" });
  }
  const grouped = new Map<string, string[]>();
  for (const pair of qa) {
    if (!pair.source_id || !pair.payload || typeof pair.payload !== "object") throw new Error("Invalid QA export row");
    const split = pair.dataset_split && ["train", "dev", "test"].includes(pair.dataset_split)
      ? pair.dataset_split : "unspecified";
    if (!grouped.has(split)) grouped.set(split, []);
    grouped.get(split)!.push(JSON.stringify(qaForDownload(pair, stage)));
  }
  // Stable file names even if a split has no QA (zero-byte JSONL is valid).
  for (const split of ["train", "dev", "test", "unspecified"]) {
    if (split !== "unspecified" || grouped.has(split)) {
      const lines = grouped.get(split) ?? [];
      result.push({ name: `${prefix}qa/${split}_v2.jsonl`, contents: lines.length ? lines.join("\n") + "\n" : "" });
    }
  }
  const csvRows: (string | number | null)[][] = [
    ["kind", "source_id", "table_id", "split", "annotate_flag", "work_status", "export_stage"],
    ...tables.map((t): (string | number | null)[] => ["table", t.source_id, t.source_id, null, t.annotate_flag, t.work_status, stage]),
    ...qa.map((q): (string | number | null)[] => ["qa", q.source_id, q.parent_source_id, q.dataset_split, q.annotate_flag, q.work_status, stage]),
  ];
  result.push({ name: `${prefix}status.csv`, contents: csvRows.map((row) => row.map(csvValue).join(",")).join("\r\n") + "\r\n" });
  result.push({ name: `${prefix}manifest.json`, contents: JSON.stringify({
    export_stage: stage, sampled_only: sampleOnly, exported_at: createdAt,
    tables: tables.length, qa: qa.length,
    description: "Table JSON objects and QA JSONL retain the original HiTAB structure and metadata.",
    notes: [
      "Current includes unfinished records; see status.csv. Untranslated fields can remain in the original language.",
      "For current/final QA, question is Indonesian when translated; the typed original answer array and all original formulas/linked cells are preserved. answer_id is the Indonesian answer text.",
      "Final contains only completed table and QA reviews with confirmed QA logic. QA without a finalized parent table are omitted.",
      "A sampled QA may require its unsampled parent table for context; such parent tables are included and marked annotate_flag=0 in status.csv.",
      "Exports are paginated live reads, NOT an atomic database snapshot. Avoid exporting while participants are making edits.",
      "Entries lacking preserved original JSON/source ID cannot be exported; review the on-screen missing-source counts.",
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
