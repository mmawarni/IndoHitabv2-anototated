#!/usr/bin/env python3
"""
Repair a partial final IndoHiTAB QA import.

Use this AFTER applying 20260927123000_allow_validation_split.sql.

It:
1) re-validates the final 878-table / 2880-QA sample against kasnerz/hitab;
2) reads existing qa_pairs from Supabase;
3) inserts ONLY expected QA rows that are missing;
4) verifies every expected table has at least one QA and all 2880 expected QA exist.

It does not delete users, tables, cells, or existing QA.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def load_importer(path: Path):
    spec = importlib.util.spec_from_file_location("final_importer", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load importer: {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def headers(key: str):
    h = {"apikey": key, "Content-Type": "application/json"}
    if not key.startswith("sb_secret_"):
        h["Authorization"] = "Bearer " + key
    return h


def get_all(url: str, key: str, table: str, select: str):
    result = []
    offset = 0
    limit = 1000
    while True:
        endpoint = (
            url.rstrip("/") + "/rest/v1/" + table
            + "?select=" + urllib.parse.quote(select, safe=",")
            + f"&limit={limit}&offset={offset}"
        )
        req = urllib.request.Request(endpoint, headers=headers(key), method="GET")
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                batch = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Read {table} HTTP {exc.code}: {detail[:1200]}") from exc
        result.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return result


def post_batches(url: str, key: str, records, size=50):
    endpoint = url.rstrip("/") + "/rest/v1/qa_pairs"
    h = headers(key)
    # Strict insert: do not hide a new schema/data error.
    h["Prefer"] = "return=minimal"

    for start in range(0, len(records), size):
        batch = records[start:start+size]
        batch_no = start // size + 1
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(batch, ensure_ascii=False, allow_nan=False).encode("utf-8"),
            headers=h,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            first = batch[0].get("original_question_id") if batch else None
            raise RuntimeError(
                f"QA repair batch {batch_no} failed (first QA {first}), "
                f"HTTP {exc.code}: {detail[:1600]}"
            ) from exc
        print(f"Inserted missing QA: {min(start + len(batch), len(records))}/{len(records)}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sample-dir", type=Path, required=True)
    p.add_argument(
        "--importer",
        type=Path,
        default=Path("scripts/import_final_sample.py"),
        help="Your corrected import_final_sample.py",
    )
    p.add_argument("--hitab-dataset", default="kasnerz/hitab")
    p.add_argument("--hitab-revision", default=None)
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()

    importer = load_importer(args.importer)
    tables, cells, qa = importer.validate_and_build(
        args.sample_dir, args.hitab_dataset, args.hitab_revision
    )

    print(f"Expected FINAL sample: {len(tables)} tables / {len(qa)} QA")

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url.startswith("https://") or not key:
        raise SystemExit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.")
    if key.startswith("sb_publishable_"):
        raise SystemExit("Use sb_secret_ or legacy service_role key, not sb_publishable_.")

    db_tables = get_all(url, key, "tqa_tables", "id,original_table_id")
    db_qa = get_all(url, key, "qa_pairs", "id,table_id,original_question_id,dataset_split")

    expected_table_ids = {str(r["id"]) for r in tables}
    db_table_ids = {str(r["id"]) for r in db_tables}

    missing_parent_tables = expected_table_ids - db_table_ids
    if missing_parent_tables:
        raise SystemExit(
            f"Cannot repair QA: {len(missing_parent_tables)} expected parent tables are missing."
        )

    expected_qa_by_id = {str(r["id"]): r for r in qa}
    db_qa_ids = {str(r["id"]) for r in db_qa}
    missing_ids = set(expected_qa_by_id) - db_qa_ids
    missing = [r for r in qa if str(r["id"]) in missing_ids]

    print(f"Current DB: {len(db_tables)} tables / {len(db_qa)} QA")
    print(f"Missing final QA: {len(missing)}")

    # Show missing split distribution before write.
    from collections import Counter
    print("Missing QA split:", dict(Counter(r["dataset_split"] for r in missing)))

    if not args.apply:
        print("DRY RUN: database untouched.")
        return

    if missing:
        post_batches(url, key, missing)

    # Final relationship verification.
    db_qa_after = get_all(url, key, "qa_pairs", "id,table_id,original_question_id,dataset_split")
    after_by_id = {str(r["id"]): r for r in db_qa_after}

    still_missing = set(expected_qa_by_id) - set(after_by_id)
    wrong_parent = []
    counts = {}
    for qid, exp in expected_qa_by_id.items():
        got = after_by_id.get(qid)
        if not got:
            continue
        if str(got["table_id"]) != str(exp["table_id"]):
            wrong_parent.append(qid)
        counts[str(exp["table_id"])] = counts.get(str(exp["table_id"]), 0) + 1

    zero_qa_tables = [
        r["original_table_id"]
        for r in tables
        if counts.get(str(r["id"]), 0) == 0
    ]

    print("\nFINAL DB CHECK")
    print("Expected tables:", len(tables))
    print("Expected QA:", len(qa))
    print("QA rows now in DB:", len(db_qa_after))
    print("Still missing expected QA:", len(still_missing))
    print("QA with wrong parent:", len(wrong_parent))
    print("Expected tables with zero QA:", len(zero_qa_tables))

    if still_missing or wrong_parent or zero_qa_tables:
        if zero_qa_tables:
            print("First zero-QA table IDs:", zero_qa_tables[:20])
        raise SystemExit("Integrity check FAILED.")

    print("Integrity check OK: all 878 expected tables have QA and all 2880 expected QA exist.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, SyntaxError) as exc:
        print("ERROR:", exc, file=sys.stderr)
        raise SystemExit(1)
