import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeading } from "@/components/AppShell";
import { useCurrentUser } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { buildExportFiles, zipStored, type ExportKind, type ExportRow, type ExportStage } from "@/lib/hitabExport";

export const Route = createFileRoute("/_authenticated/ekspor")({
  head: () => ({ meta: [{ title: "Ekspor dataset — IndoHiTAB" }] }),
  component: DatasetExport,
});
const PAGE_SIZE = 100;
type Summary = {
  tables_current: number; qa_current: number; tables_final: number; qa_final: number;
  tables_missing_source: number; qa_missing_source: number; qa_waiting_for_table_final: number;
};

function DatasetExport() {
  const { isAdmin, rolesLoading, rolesError } = useCurrentUser();
  const [stage, setStage] = useState<ExportStage>("current");
  const [sampleOnly, setSampleOnly] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const cancelRef = useRef(false);
  const summary = useQuery({
    queryKey: ["export-summary", sampleOnly], enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("hitab_export_summary", { _sample_only: sampleOnly });
      if (error) throw error;
      return data?.[0] as Summary | undefined;
    },
  });

  async function fetchKind(kind: ExportKind, stageValue: ExportStage, sample: boolean): Promise<ExportRow[]> {
    const all: ExportRow[] = [];
    let expected: number | null = null;
    do {
      if (cancelRef.current) throw new Error("Ekspor dibatalkan; tidak ada file parsial yang diunduh.");
      const { data, error } = await supabase.rpc("hitab_export_page", {
        _kind: kind, _stage: stageValue, _sample_only: sample,
        _limit: PAGE_SIZE, _offset: all.length,
      });
      if (error) throw error;
      const rows = (data ?? []) as unknown as ExportRow[];
      if (!rows.length) {
        if (expected !== null && all.length !== expected) throw new Error("Data berubah selama ekspor. Coba ulang ketika anotasi sedang tidak berjalan.");
        break;
      }
      if (expected === null) expected = Number(rows[0].total_count);
      if (rows.some((row) => Number(row.total_count) !== expected)) throw new Error("Dataset berubah selama ekspor. Silakan coba kembali.");
      all.push(...rows);
      setProgress(`Mengambil ${kind === "table" ? "tabel" : "QA"}: ${all.length} / ${expected}`);
      if (all.length > expected) throw new Error("Jumlah baris ekspor tidak konsisten.");
    } while (all.length < (expected ?? 0));
    return all;
  }

  async function download() {
    if (!isAdmin || running) return;
    cancelRef.current = false;
    setRunning(true);
    setProgress("Memulai ekspor…");
    try {
      const tables = await fetchKind("table", stage, sampleOnly);
      const qa = await fetchKind("qa", stage, sampleOnly);
      if (cancelRef.current) throw new Error("Ekspor dibatalkan; tidak ada file parsial yang diunduh.");
      setProgress("Membuat arsip ZIP dan status.csv…");
      const files = buildExportFiles(stage, sampleOnly, tables, qa, new Date().toISOString());
      const zip = zipStored(files);
      // Uint8Array may use a SharedArrayBuffer with some TS lib definitions;
      // copy into an ArrayBuffer-backed view accepted by the Blob constructor.
      const bytes = new Uint8Array(zip.length);
      bytes.set(zip);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `indohitab-${stage}-${sampleOnly ? "sample" : "all"}-${new Date().toISOString().slice(0,10)}.zip`;
      document.body.appendChild(anchor);
      anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setProgress(`Selesai: ${tables.length} tabel dan ${qa.length} QA.`);
      toast.success("Arsip ekspor dibuat. Periksa folder Downloads.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gagal mengekspor dataset.";
      setProgress(message);
      toast.error(message);
    } finally { setRunning(false); }
  }

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert" className="text-sm text-amber">Gagal memuat peran. Muat ulang halaman.</p>;
  if (!isAdmin) return <p role="alert" className="text-sm text-mist">Hanya Admin yang dapat mengekspor dataset.</p>;
  const counts = summary.data;
  return <section className="mx-auto max-w-5xl">
    <PageHeading eyebrow="c · dataset" title="Ekspor dataset IndoHiTAB" />
    <p className="mb-6 max-w-3xl text-sm leading-relaxed text-mist">
      Unduh tabel sebagai file JSON terpisah dan pertanyaan–jawaban sebagai JSONL per split, dengan struktur hierarki,
      merged regions, jawaban bertipe asli, aggregation, formula, dan linked cells tetap dipertahankan.
      Status setiap entri terdapat di <code>status.csv</code>.
    </p>
    <div className="panel space-y-6 p-5">
      <fieldset disabled={running} className="space-y-3">
        <legend className="label-mono mb-3">Versi data yang diunduh</legend>
        {([
          ["original", "Asli", "JSON sumber tanpa perubahan"],
          ["current", "Saat ini", "Snapshot anotator terkini, termasuk draft dan belum dimulai"],
          ["final", "Final tervalidasi", "Hanya review selesai; QA juga memerlukan tabel induk final"],
        ] as const).map(([value, label, note]) =>
          <label key={value} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line/70 p-3 text-sm">
            <input type="radio" name="export-stage" checked={stage === value} onChange={() => setStage(value)} />
            <span><strong className="block">{label}</strong><span className="text-xs text-mist">{note}</span></span>
          </label>
        )}
      </fieldset>
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" checked={sampleOnly} disabled={running} onChange={(event) => setSampleOnly(event.target.checked)} />
        Hanya sampel (annotate_flag = 1). Tabel induk QA tetap disertakan sebagai konteks meski flag tabel = 0.
      </label>
      {summary.error && <p role="alert" className="text-sm text-amber">Gagal memuat ringkasan: {summary.error.message}. Pastikan migration v5 sudah dijalankan.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-frost p-4">
          <div className="label-mono">Tabel {stage === "final" ? "final" : "tersedia"}</div>
          <div className="font-display mt-2 text-2xl font-bold">{counts ? (stage === "final" ? counts.tables_final : counts.tables_current) : "—"}</div>
        </div>
        <div className="rounded-xl bg-frost p-4">
          <div className="label-mono">QA {stage === "final" ? "final" : "tersedia"}</div>
          <div className="font-display mt-2 text-2xl font-bold">{counts ? (stage === "final" ? counts.qa_final : counts.qa_current) : "—"}</div>
        </div>
      </div>
      {counts && (counts.tables_missing_source > 0 || counts.qa_missing_source > 0 || counts.qa_waiting_for_table_final > 0) &&
        <p className="rounded-lg bg-amber/10 p-3 text-xs text-amber" role="status">
          {counts.tables_missing_source} tabel / {counts.qa_missing_source} QA tidak mempunyai JSON sumber atau ID asli yang lengkap sehingga tidak diekspor.
          {` ${counts.qa_waiting_for_table_final} QA sudah tervalidasi tetapi belum dapat masuk ekspor final karena tabel induknya belum final.`}
        </p>}
      <p className="text-xs text-mist">
        QA versi saat ini/final menggunakan <code>question</code> Indonesia jika tersedia, tetapi <code>answer</code> bertipe asli tidak ditimpa;
        teks jawaban Indonesia berada pada <code>answer_id</code>. Ekspor membaca data secara bertahap, bukan snapshot transaksi tunggal.
        Hindari menjalankannya ketika anotator/validator sedang mengubah data.
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={running || summary.isPending || Boolean(summary.error)} onClick={download}
          className="rounded-xl bg-teal px-5 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-40">
          {running ? "Sedang menyiapkan…" : `Download ${stage === "final" ? "final" : stage === "original" ? "asli" : "status saat ini"} (.zip)`}
        </button>
        {running && <button type="button" onClick={() => { cancelRef.current = true; setProgress("Membatalkan setelah halaman aktif selesai…"); }}
          className="rounded-xl px-4 py-3 text-sm ring-1 ring-line">Batalkan</button>}
      </div>
      {progress && <p className="font-mono text-xs text-mist" role="status" aria-live="polite">{progress}</p>}
    </div>
  </section>;
}
