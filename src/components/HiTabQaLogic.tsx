import { useState } from "react";
import type { Json } from "@/integrations/supabase/types";

function jsonText(v: unknown) { return v === undefined ? "Tidak tersedia" : JSON.stringify(v, null, 2); }
/** Original QA reasoning is displayed read-only; translation must not alter it. */
export function HiTabQaLogic({ original, collapsible = false }: {
  original: Json | null | undefined;
  /** Adds a show/hide toggle, hidden by default. */
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  if (!original || typeof original !== "object" || Array.isArray(original)) {
    return <p className="text-xs text-mist">Metadata penalaran QA asli belum diimpor.</p>;
  }
  const qa=original as Record<string,unknown>;
  return <section className="rounded-lg bg-paper/60 p-3 text-xs">
    <div className={`flex items-center gap-2 ${open ? "mb-2" : ""}`}>
      <div className="label-mono">QA asli · Penalaran tidak boleh diubah</div>
      {collapsible && <button type="button" tabIndex={-1} onClick={()=>setOpen((v)=>!v)} aria-expanded={open}
        className="ml-auto rounded-lg px-3 py-1 font-mono text-[11px] text-mist ring-1 ring-line transition-colors hover:bg-ink/5">
        {open ? "Sembunyikan" : "Tampilkan"}
      </button>}
    </div>
    {open && <dl className="grid gap-2">
      {(["answer","aggregation","answer_formulas","reference_cells_map","linked_cells"] as const).map((key)=><div key={key}>
        <dt className="font-semibold">{key}</dt><dd className="overflow-x-auto whitespace-pre-wrap break-words font-mono">{jsonText(qa[key])}</dd>
      </div>)}
    </dl>}
  </section>;
}
