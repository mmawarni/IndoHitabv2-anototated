import type { Json } from "@/integrations/supabase/types";

type Region = { first_row: number; last_row: number; first_column: number; last_column: number };
type TableShape = {
  title?: string;
  texts: unknown[][];
  merged_regions?: Region[];
  top_header_rows_num?: number;
  left_header_columns_num?: number;
};

function asTable(value: Json | null | undefined): TableShape | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const maybe = value as Record<string, unknown>;
  if (!Array.isArray(maybe.texts) || !maybe.texts.every(Array.isArray)) return null;
  return maybe as unknown as TableShape;
}

function text(value: unknown) { return value === null || value === undefined ? "" : String(value); }

/** Render source or translated HiTAB *matrix*, not a fabricated header/column layout. */
export function HiTabTablePreview({ snapshot, label }: { snapshot: Json | null | undefined; label: string }) {
  const table = asTable(snapshot);
  if (!table) return <p className="text-xs text-mist">JSON tabel belum tersedia; tidak membuat pratinjau palsu.</p>;
  const regions = new Map<string, Region>();
  const hidden = new Set<string>();
  for (const region of table.merged_regions ?? []) {
    if (![region.first_row,region.last_row,region.first_column,region.last_column].every(Number.isInteger)) continue;
    if (region.first_row < 0 || region.first_column < 0 || region.last_row < region.first_row || region.last_column < region.first_column) continue;
    regions.set(`${region.first_row}:${region.first_column}`,region);
    for (let r=region.first_row;r<=region.last_row;r++) for (let c=region.first_column;c<=region.last_column;c++) {
      if (r!==region.first_row || c!==region.first_column) hidden.add(`${r}:${c}`);
    }
  }
  const top = table.top_header_rows_num ?? 0;
  const left = table.left_header_columns_num ?? 0;
  return <div className="min-w-0">
    <div className="label-mono mb-2">{label}: {table.title ?? "Tanpa judul"}</div>
    <div className="max-h-[26rem] overflow-auto rounded-lg ring-1 ring-line">
      <table className="w-max min-w-full border-collapse text-xs">
        <tbody>{table.texts.map((row,r)=><tr key={r}>{row.map((value,c)=>{
          if (hidden.has(`${r}:${c}`)) return null;
          const region=regions.get(`${r}:${c}`);
          const header=r<top || c<left;
          const Tag=header?"th":"td";
          return <Tag key={`${r}:${c}`} rowSpan={region?region.last_row-r+1:1}
            colSpan={region?region.last_column-c+1:1}
            className={`border border-line/70 px-3 py-2 text-left align-top ${header?"bg-teal/10 font-semibold":""}`}>
            {text(value)}
          </Tag>;
        })}</tr>)}</tbody>
      </table>
    </div>
  </div>;
}
