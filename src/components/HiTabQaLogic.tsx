import type { Json } from "@/integrations/supabase/types";

function jsonText(v: unknown) { return v === undefined ? "Tidak tersedia" : JSON.stringify(v, null, 2); }
/** Original QA reasoning is displayed read-only; translation must not alter it. */
export function HiTabQaLogic({ original }: { original: Json | null | undefined }) {
  if (!original || typeof original !== "object" || Array.isArray(original)) {
    return <p className="text-xs text-mist">Metadata penalaran QA asli belum diimpor.</p>;
  }
  const qa=original as Record<string,unknown>;
  return <section className="rounded-lg bg-paper/60 p-3 text-xs">
    <div className="label-mono mb-2">QA asli · Penalaran tidak boleh diubah</div>
    <dl className="grid gap-2">
      {(["answer","aggregation","answer_formulas","reference_cells_map","linked_cells"] as const).map((key)=><div key={key}>
        <dt className="font-semibold">{key}</dt><dd className="overflow-x-auto whitespace-pre-wrap break-words font-mono">{jsonText(qa[key])}</dd>
      </div>)}
    </dl>
  </section>;
}
