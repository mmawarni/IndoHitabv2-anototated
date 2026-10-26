#!/usr/bin/env python3
"""
Replace the ACTIVE IndoHiTAB main sample with all ToTTo + all NSF from the
provided CSVs, while preserving every existing live pilot row and its work.

What this script does:
- NEVER deletes pilot rows;
- NEVER overwrites existing Indonesian translations/reviews;
- deactivates old NON-PILOT tables that are outside the new main sample;
- activates/updates existing NSF/ToTTo rows to their new batch;
- inserts missing NSF/ToTTo tables, cells and QA;
- leaves dataset_split NULL for newly inserted QA (download is no longer split);
- infers current batch annotator/validator assignments and applies them only to
  newly inserted rows.

Run first without --apply.
"""

from __future__ import annotations
import argparse, ast, collections, csv, json, os, sys, urllib.parse, urllib.request, urllib.error, uuid
from pathlib import Path
from typing import Any

NAMESPACE = uuid.UUID("c9e4e1a7-27a7-4bac-a7a6-c7bc1289ca37")
SOURCE_ID = {"nsf": 2, "totto": 4}

def stable(kind: str, value: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{kind}:{value}"))

def literal(v: Any) -> Any:
    if not isinstance(v, str):
        return v
    s = v.strip()
    if not s:
        return v
    for fn in (json.loads, ast.literal_eval):
        try:
            return fn(s)
        except Exception:
            pass
    return v

def read_csv(path: Path):
    with path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))

def headers(key: str, prefer: str | None = None):
    h = {"apikey": key, "Content-Type": "application/json"}
    if not key.startswith("sb_secret_"):
        h["Authorization"] = "Bearer " + key
    if prefer:
        h["Prefer"] = prefer
    return h

def request_json(url: str, key: str, method="GET", payload=None, prefer=None):
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
    req = urllib.request.Request(url, data=data, headers=headers(key, prefer), method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            return json.loads(raw.decode()) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} -> HTTP {e.code}: {detail[:1200]}") from e

def get_all(base: str, key: str, table: str, select: str):
    rows = []
    offset = 0
    limit = 1000
    while True:
        query = urllib.parse.urlencode({
            "select": select,
            "limit": limit,
            "offset": offset,
        })
        page = request_json(f"{base.rstrip('/')}/rest/v1/{table}?{query}", key)
        page = page or []
        rows.extend(page)
        if len(page) < limit:
            break
        offset += limit
    return rows

def patch(base, key, table, filter_expr, payload):
    url = f"{base.rstrip('/')}/rest/v1/{table}?{filter_expr}"
    request_json(url, key, method="PATCH", payload=payload, prefer="return=minimal")

def post_chunks(base, key, table, records, size=50):
    if not records:
        return
    url = f"{base.rstrip('/')}/rest/v1/{table}"
    for i in range(0, len(records), size):
        chunk = records[i:i+size]
        request_json(
            url, key, method="POST", payload=chunk,
            prefer="resolution=ignore-duplicates,return=minimal"
        )
        if (i // size + 1) % 20 == 0:
            print(f"  {table}: {min(i+size, len(records))}/{len(records)}", flush=True)

def normalize_qa(row):
    def maybe_int(v):
        s = str(v).strip()
        if not s:
            return None
        try:
            return int(s)
        except ValueError:
            return s
    return {
        "id": str(row["id"]),
        "table_id": str(row["table_id"]),
        "table_source": str(row["table_source"]),
        "sentence_id": maybe_int(row.get("sentence_id", "")),
        "sub_sentence_id": str(row.get("sub_sentence_id", "")),
        "sub_sentence": str(row.get("sub_sentence", "")),
        "question": str(row["question"]),
        "answer": literal(row["answer"]),
        "aggregation": literal(row["aggregation"]),
        "linked_cells": literal(row["linked_cells"]),
        "answer_formulas": literal(row["answer_formulas"]),
        "reference_cells_map": literal(row["reference_cells_map"]),
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample-dir", type=Path, default=Path("."))
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    trows = read_csv(args.sample_dir / "tables_sample.csv")
    qrows = read_csv(args.sample_dir / "qa_sample.csv")
    brows = read_csv(args.sample_dir / "batches.csv")

    tables = {str(r["table_id"]): r for r in trows}
    batches = {str(r["table_id"]): r for r in brows}
    q_by_table = collections.defaultdict(list)
    for r in qrows:
        q_by_table[str(r["table_id"])].append(r)

    if len(tables) != len(trows):
        raise ValueError("Duplicate table_id")
    if len({str(r["id"]) for r in qrows}) != len(qrows):
        raise ValueError("Duplicate QA id")
    if set(tables) != set(batches):
        raise ValueError("batches.csv must contain every selected table exactly once")
    if {str(r["table_source"]).lower() for r in trows} != {"nsf", "totto"}:
        raise ValueError("Replacement sample must contain only NSF and ToTTo")

    for tid, row in tables.items():
        if len(q_by_table[tid]) != int(row["qa_count"]):
            raise ValueError(f"qa_count mismatch: {tid}")

    per_batch = collections.Counter(int(r["batch"]) for r in brows)
    qa_per_batch = collections.Counter(
        int(batches[str(q["table_id"])]["batch"]) for q in qrows
    )
    print(f"NEW MAIN SAMPLE: {len(trows)} tables / {len(qrows)} QA")
    print("Sources:", collections.Counter(str(r["table_source"]).lower() for r in trows))
    print("Batches:", ", ".join(
        f"B{b}={per_batch[b]} tables/{qa_per_batch[b]} QA" for b in range(1, 9)
    ))

    if not args.apply:
        print("DRY RUN: database untouched.")
        print("Apply only after making a backup and setting SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.")
        return

    base = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not base.startswith("https://") or not key:
        raise SystemExit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in this terminal.")

    print("Reading current DB state...")
    db_tables = get_all(
        base, key, "tqa_tables",
        "id,original_table_id,is_pilot,annotate_flag,batch_no,annotator_id,validator_id,assigned_to"
    )
    db_qa = get_all(
        base, key, "qa_pairs",
        "id,original_question_id,table_id,is_pilot,annotate_flag,batch_no,annotator_id,validator_id"
    )

    by_tid = {str(r["original_table_id"]): r for r in db_tables if r.get("original_table_id")}
    by_qid = {str(r["original_question_id"]): r for r in db_qa if r.get("original_question_id")}

    # Infer existing batch assignments so newly added rows join the same workers.
    ann_counts = collections.defaultdict(collections.Counter)
    val_counts = collections.defaultdict(collections.Counter)
    for r in db_tables:
        b = r.get("batch_no")
        if b is None:
            continue
        if r.get("annotator_id"):
            ann_counts[int(b)][r["annotator_id"]] += 1
        if r.get("validator_id"):
            val_counts[int(b)][r["validator_id"]] += 1

    batch_ann = {
        b: c.most_common(1)[0][0] for b, c in ann_counts.items() if c
    }
    batch_val = {
        b: c.most_common(1)[0][0] for b, c in val_counts.items() if c
    }

    new_ids = set(tables)
    pilot_rows = [r for r in db_tables if r.get("is_pilot") is True]
    print(f"Existing pilot rows preserved unchanged: {len(pilot_rows)} tables")

    # Deactivate old non-pilot rows outside the new main sample.
    removed = [
        r for r in db_tables
        if r.get("original_table_id")
        and r["original_table_id"] not in new_ids
        and r.get("is_pilot") is not True
        and r.get("annotate_flag") == 1
    ]
    print(f"Deactivating old non-pilot tables outside new main sample: {len(removed)}")
    for i, r in enumerate(removed, 1):
        patch(base, key, "tqa_tables", "id=eq." + urllib.parse.quote(str(r["id"])), {"annotate_flag": 0})
        patch(base, key, "qa_pairs", "table_id=eq." + urllib.parse.quote(str(r["id"])), {"annotate_flag": 0})
        if i % 100 == 0:
            print(f"  deactivated {i}/{len(removed)}", flush=True)

    # Activate/update all existing rows in the new sample, preserving translations/reviews/pilot flag.
    existing_selected = 0
    for tid, src in tables.items():
        cur = by_tid.get(tid)
        if not cur:
            continue
        b = int(batches[tid]["batch"])
        patch(
            base, key, "tqa_tables",
            "id=eq." + urllib.parse.quote(str(cur["id"])),
            {"annotate_flag": 1, "batch_no": b}
        )
        patch(
            base, key, "qa_pairs",
            "table_id=eq." + urllib.parse.quote(str(cur["id"])),
            {"annotate_flag": 1, "batch_no": b}
        )
        existing_selected += 1
    print(f"Existing selected tables preserved/activated: {existing_selected}")

    # Build records for missing tables/cells.
    table_records = []
    cell_records = []
    table_uuid_by_tid = {}

    for tid, r in tables.items():
        b = int(batches[tid]["batch"])
        source = str(r["table_source"]).lower().strip()
        original = literal(r["table_content"])
        if not isinstance(original, dict):
            raise ValueError(f"Malformed table_content: {tid}")

        if tid in by_tid:
            table_uuid_by_tid[tid] = str(by_tid[tid]["id"])
            continue

        table_uuid = stable("table", tid)
        table_uuid_by_tid[tid] = table_uuid
        ann = batch_ann.get(b)
        val = batch_val.get(b)

        table_records.append({
            "id": table_uuid,
            "code": "HITAB:" + tid,
            "original_table_id": tid,
            "title_en": str(original.get("title", "")),
            "original_table": original,
            "annotated_table": original,
            "validated_table": None,
            "annotate_flag": 1,
            "batch_no": b,
            "is_pilot": False,
            "data_source_id": SOURCE_ID[source],
            "annotator_id": ann,
            "validator_id": val,
            "assigned_to": ann,
        })

        top = int(original.get("top_header_rows_num", 0) or 0)
        left = int(original.get("left_header_columns_num", 0) or 0)
        pos = 0
        for rr, row in enumerate(original.get("texts", [])):
            for cc, value in enumerate(row):
                if (rr >= top and cc >= left) or value is None or not str(value).strip():
                    continue
                cell_records.append({
                    "id": stable("cell", f"{tid}:{rr}:{cc}"),
                    "table_id": table_uuid,
                    "row_index": rr,
                    "column_index": cc,
                    "position": pos,
                    "kind": "header" if rr < top else "column",
                    "source_text": str(value),
                })
                pos += 1

    print(f"Inserting missing tables: {len(table_records)}")
    post_chunks(base, key, "tqa_tables", table_records)
    print(f"Inserting missing cells: {len(cell_records)}")
    post_chunks(base, key, "table_cells", cell_records)

    # Insert missing QA. Existing QA translations are never overwritten.
    positions = collections.defaultdict(int)
    qa_records = []
    for r in qrows:
        qid = str(r["id"])
        tid = str(r["table_id"])
        b = int(batches[tid]["batch"])
        pos = positions[tid]
        positions[tid] += 1
        if qid in by_qid:
            continue

        original = normalize_qa(r)
        answer = original.get("answer")
        answer_en = ", ".join(str(x) for x in answer) if isinstance(answer, list) else str(answer)
        ann = batch_ann.get(b)
        val = batch_val.get(b)

        qa_records.append({
            "id": stable("qa", qid),
            "table_id": table_uuid_by_tid[tid],
            "original_question_id": qid,
            "position": pos,
            "question_en": str(original["question"]),
            "answer_en": answer_en,
            "original_qa": original,
            "annotated_qa": original,
            "validated_qa": None,
            "dataset_split": None,
            "annotate_flag": 1,
            "batch_no": b,
            "is_pilot": False,
            "data_source_id": SOURCE_ID[str(r["table_source"]).lower().strip()],
            "annotator_id": ann,
            "validator_id": val,
        })

    print(f"Inserting missing QA: {len(qa_records)}")
    post_chunks(base, key, "qa_pairs", qa_records)

    print("DONE.")
    print("Main sample target:", len(trows), "tables /", len(qrows), "QA")
    print("Historical pilot data remained untouched.")
    print("Next: run the overlap replacement SQL supplied with this package.")

if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, SyntaxError) as e:
        print("ERROR:", e, file=sys.stderr)
        sys.exit(1)
