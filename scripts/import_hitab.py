#!/usr/bin/env python3
"""Import original HiTAB ZIP without converting or overwriting original JSON.

Default is offline dry run. --apply requires a LOCAL service-role key (NEVER put it in VITE_*).
Missing table JSON in this uploaded sample is reported and its QA is skipped, never fabricated.
This only inserts new deterministic IDs; it intentionally cannot overwrite translations.
"""
import argparse
import collections
import json
import os
import re
import sys
import uuid
import urllib.error
import urllib.parse
import urllib.request
import zipfile

NAMESPACE = uuid.UUID("c9e4e1a7-27a7-4bac-a7a6-c7bc1289ca37")

def stable(kind, value):
    return str(uuid.uuid5(NAMESPACE, kind + ":" + str(value)))

def json_load(blob):
    return json.loads(blob.decode("utf-8"))

def read_zip(path):
    with zipfile.ZipFile(path) as archive:
        paths = [name for name in archive.namelist() if not name.startswith("__MACOSX/")]
        table_paths = sorted(name for name in paths if "/table/" in name and name.endswith(".json"))
        table_json = {name.rsplit("/",1)[-1][:-5]: json_load(archive.read(name)) for name in table_paths}
        pairs = []
        for split in ("train", "dev", "test"):
            candidates = [name for name in paths if re.search(r"/qa/" + split + r"_v2\.jsonl$",name)]
            for name in candidates:
                for line in archive.read(name).splitlines():
                    if line.strip(): pairs.append((split,json_load(line)))
    if not table_json or not pairs: raise ValueError("No table JSON or QA JSONL found; check ZIP layout")
    ids=[qa["id"] for _,qa in pairs]
    if len(set(ids))!=len(ids): raise ValueError("Duplicate original QA IDs across splits")
    return table_json,pairs

def prepare_tables(tables,selected):
    for source_id in sorted(selected):
        original=tables[source_id]
        yield {"id":stable("table",source_id),"code":"HITAB:"+source_id,
               "original_table_id":source_id,"title_en":str(original["title"]),
               "original_table":original,"annotated_table":original,"annotate_flag":1}

def prepare_cells(tables,selected):
    for source_id in sorted(selected):
        t=tables[source_id]; rows=t.get("texts",[])
        top=t.get("top_header_rows_num",0); left=t.get("left_header_columns_num",0)
        if not isinstance(top,int) or not isinstance(left,int): raise ValueError(f"Invalid header extents {source_id}")
        position=0
        for r,row in enumerate(rows):
            for c,value in enumerate(row):
                if (r>=top and c>=left) or value is None or not str(value).strip(): continue
                yield {"id":stable("cell",f"{source_id}:{r}:{c}"),"table_id":stable("table",source_id),
                       "row_index":r,"column_index":c,"position":position,
                       "kind":"header" if r<top else "column","source_text":str(value)}
                position+=1

def prepare_qa(pairs,selected):
    positions=collections.defaultdict(int)
    for split,qa in pairs:
        tid=qa["table_id"]
        if tid not in selected: continue
        position=positions[tid];positions[tid]+=1
        answer=qa["answer"]
        # Display-only English string; canonical typed list is in original_qa['answer'].
        answer_en=", ".join(str(v) for v in answer) if isinstance(answer,list) else str(answer)
        yield {"id":stable("qa",qa["id"]),"table_id":stable("table",tid),
               "original_question_id":qa["id"],"position":position,
               "question_en":str(qa["question"]),"answer_en":answer_en,
               "original_qa":qa,"dataset_split":split,"annotate_flag":1}

def batches(records,size):
    chunk=[]
    for record in records:
        chunk.append(record)
        if len(chunk)>=size:
            yield chunk;chunk=[]
    if chunk:yield chunk

def post_rows(url,key,table,records):
    endpoint=url.rstrip("/")+"/rest/v1/"+urllib.parse.quote(table)
    headers={"apikey":key,"Content-Type":"application/json",
             "Prefer":"resolution=ignore-duplicates,return=minimal"}
    # New opaque sb_secret_* keys are not JWTs; legacy service-role JWTs use Bearer.
    if not key.startswith("sb_secret_"):
        headers["Authorization"]="Bearer "+key
    for i,batch in enumerate(batches(records,50),1):
        body=json.dumps(batch,ensure_ascii=False,allow_nan=False).encode("utf8")
        req=urllib.request.Request(endpoint,data=body,headers=headers,method="POST")
        try:
            with urllib.request.urlopen(req,timeout=90) as response: response.read()
        except urllib.error.HTTPError as e:
            detail=e.read().decode("utf8",errors="replace")
            raise RuntimeError(f"Import {table} batch {i} failed HTTP {e.code}: {detail[:400]}") from e
        if i%20==0:print(f"  {table}: {i*50} rows processed",flush=True)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("zip_path",help="local original HiTAB ZIP; never commit it to public Git")
    p.add_argument("--apply",action="store_true",help="write to Supabase (dry run is default)")
    p.add_argument("--limit-tables",type=int,default=None,help="smoke-test with N tables; no overwrite")
    p.add_argument("--table-ids",help="optional local UTF-8 file: one original table ID per line")
    args=p.parse_args()
    tables,pairs=read_zip(args.zip_path)
    selected=set(tables)
    if args.table_ids:
        with open(args.table_ids,encoding="utf8") as stream: requested={line.strip() for line in stream if line.strip() and not line.startswith("#")}
        missing=requested-selected
        if missing: raise ValueError(f"Requested table JSON missing: {sorted(missing)[:10]}")
        selected=requested
    if args.limit_tables is not None:
        if args.limit_tables<1:raise ValueError("--limit-tables must be >0")
        selected=set(sorted(selected)[:args.limit_tables])
    missing_qa=collections.Counter(qa["table_id"] for _,qa in pairs if qa["table_id"] not in tables)
    included_qa=sum(qa["table_id"] in selected for _,qa in pairs)
    cells_count=sum(1 for _ in prepare_cells(tables,selected))
    print(f"Source: {len(tables)} table JSON; {len(pairs)} QA; {len(missing_qa)} referenced table IDs have NO JSON")
    print(f"Selected: {len(selected)} tables; {cells_count} header/row-label cells; {included_qa} QA")
    print(f"Unmatched QA: {sum(missing_qa.values())} (skipped, not fabricated)")
    print("Sampling: annotate_flag = 1 for every newly inserted table and QA; edit later via admin RPC.")
    print("Insert-only: existing records are NOT updated. Check for already-imported records before --apply.")
    if not args.apply:
        print("DRY RUN; database untouched. Add --apply to import.")
        return
    url=os.environ.get("SUPABASE_URL","").strip();key=os.environ.get("SUPABASE_SERVICE_ROLE_KEY","").strip()
    if not url.startswith("https://") or not key:
        raise SystemExit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your LOCAL terminal; do NOT use VITE_* or commit secrets.")
    for table,records in (("tqa_tables",prepare_tables(tables,selected)),
                          ("table_cells",prepare_cells(tables,selected)),
                          ("qa_pairs",prepare_qa(pairs,selected))):
        print("Inserting",table,flush=True)
        post_rows(url,key,table,records)
    print("Done. Verify table count, QA count, snapshot fields and unmatched references in SQL Editor.")

if __name__=="__main__":
    try: main()
    except (ValueError,RuntimeError,zipfile.BadZipFile) as e:
        print("ERROR:",e,file=sys.stderr);sys.exit(1)
