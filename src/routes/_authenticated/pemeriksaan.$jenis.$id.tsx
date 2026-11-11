import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeading } from "@/components/AppShell";
import { useCurrentUser } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { HiTabTablePreview } from "@/components/HiTabTablePreview";
import { useWorkOpen } from "@/hooks/useWorkOpen";
import { CopyButton, focusNextField } from "@/components/TranslationFields";
import { QaReviewForm } from "@/components/QaReviewForm";

export const Route = createFileRoute("/_authenticated/pemeriksaan/$jenis/$id")({
  head: () => ({ meta: [{ title: "Form Pemeriksaan — HiTab TQA" }] }),
  component: ReviewDetail,
});

function ReviewDetail() {
  const { jenis, id } = Route.useParams();
  const { isValidator, isAdmin, rolesLoading, rolesError } = useCurrentUser();
  const allowed = isValidator || isAdmin;

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert" className="text-sm text-amber">Gagal memuat peran. Muat ulang halaman.</p>;
  if (!allowed) return <p role="alert" className="text-sm text-mist">Halaman ini hanya untuk Validator atau Admin.</p>;
  if (jenis === "tabel") return <TableReview id={id} />;
  if (jenis === "pertanyaan") return <QuestionReview id={id} />;
  return <p>Jenis pemeriksaan tidak dikenal.</p>;
}

function BackLink() {
  return <Link to="/pemeriksaan" className="font-mono text-[11px] text-teal hover:underline">← daftar pemeriksaan</Link>;
}

function QuestionReview({ id }: { id: string }) {
  // Table code for the heading; the form loads (and caches) the full pair itself.
  const { data } = useQuery({
    queryKey: ["review-detail", "pertanyaan-code", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("qa_pairs").select("tqa_tables(code)").eq("id", id).maybeSingle();
      if (error) throw error;
      return data?.tqa_tables?.code ?? "";
    },
  });
  return (
    <section>
      <PageHeading eyebrow={`v · pertanyaan · ${data ?? ""}`} title="Pemeriksaan terjemahan" right={<BackLink />} />
      <QaReviewForm pairId={id} withTablePreview />
      <p className="mt-4 text-xs text-mist">Hasil validator disimpan terpisah dari terjemahan asli untuk menjaga jejak pemeriksaan.</p>
    </section>
  );
}

type ReviewStatus = "sedang_diperiksa" | "selesai";
type CellCorrections = Record<string, string>;

/** Copy of a HiTAB snapshot with the validator's title and cell corrections applied. */
function applyCorrections(
  snapshot: Json | null | undefined,
  title: string,
  cells: { id: string; row_index: number | null; column_index: number | null }[],
  corrections: CellCorrections,
): Json | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const texts = (snapshot as Record<string, unknown>)["texts"];
  if (!Array.isArray(texts) || !texts.every(Array.isArray)) return null;
  const next = texts.map((row) => [...(row as unknown[])]);
  for (const cell of cells) {
    if (cell.row_index === null || cell.column_index === null) continue;
    const row = next[cell.row_index];
    if (row && cell.column_index < row.length) row[cell.column_index] = corrections[cell.id] ?? "";
  }
  return { ...snapshot, title, texts: next } as Json;
}

function TableReview({ id }: { id: string }) {
  const { userId, isValidator, isAdmin } = useCurrentUser();
  const allowed = isValidator || isAdmin;
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [cells, setCells] = useState<CellCorrections>({});
  const [dirty, setDirty] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [activeTab, setActiveTab] = useState<"header" | "qa">("header");
  const [activePair, setActivePair] = useState(0);

  const { data, isPending, error } = useQuery({
    queryKey: ["review-detail", "tabel", id],
    enabled: allowed,
    queryFn: async () => {
      const [t, c, r, q] = await Promise.all([
        supabase.from("tqa_tables").select("id, code, title_en, title_id, original_table, annotated_table, validated_table, annotate_flag, validator_id").eq("id", id).maybeSingle(),
        supabase.from("table_cells").select("id, kind, position, source_text, target_text, status, row_index, column_index").eq("table_id", id).order("position"),
        supabase.from("table_reviews").select("id, reviewer_id, status, reviewed_title_id, corrected_cells").eq("table_id", id).maybeSingle(),
        supabase.from("qa_pairs").select("id").eq("table_id", id).eq("annotate_flag", 1).order("position"),
      ]);
      if (t.error) throw t.error;
      if (c.error) throw c.error;
      if (r.error) throw r.error;
      if (q.error) throw q.error;
      return { table: t.data, cells: c.data ?? [], review: r.data, pairIds: (q.data ?? []).map((p) => p.id) };
    },
  });

  useEffect(() => {
    if (!data) return;
    setTitle(data.review?.reviewed_title_id ?? data.table?.title_id ?? "");
    const saved = data.review?.corrected_cells;
    const savedCells: CellCorrections = saved && typeof saved === "object" && !Array.isArray(saved)
      ? Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
    setCells(Object.fromEntries(data.cells.map((cell) => [cell.id, savedCells[cell.id] ?? cell.target_text ?? ""])));
    setDirty(false);
  }, [data]);

  const ready = data?.table?.annotate_flag === 1 && !!data.table?.title_id?.trim() && data.cells.length > 0
    && data.cells.every((cell) => !!cell.target_text?.trim() && cell.status === "selesai");
  const sampled = data?.table?.annotate_flag === 1;
  const notAssigned = !isAdmin && data?.table?.validator_id !== userId;
  const ownedByOther = !!data?.review?.reviewer_id && data.review.reviewer_id !== userId && !isAdmin;
  const canEdit = allowed && ready && !notAssigned && !ownedByOther && !!userId;
  useWorkOpen("table_review", id, canEdit);

  const save = useMutation({
    mutationFn: async (status: ReviewStatus) => {
      if (!data || !canEdit || !userId) throw new Error("Pemeriksaan tidak tersedia untuk akun atau entri ini.");
      if (status === "selesai" && (!title.trim() || data.cells.some((c) => !cells[c.id]?.trim()))) {
        throw new Error("Semua hasil pemeriksaan judul dan sel wajib terisi.");
      }
      const values = { status, reviewed_title_id: title.trim(), corrected_cells: cells as Json };
      if (data.review) {
        const { data: updated, error } = await supabase.from("table_reviews")
          .update(values).eq("id", data.review.id).select("id").maybeSingle();
        if (error) throw error;
        if (!updated) throw new Error("Pemeriksaan telah berubah. Muat ulang halaman.");
      } else {
        const { error } = await supabase.from("table_reviews").insert({
          table_id: id, reviewer_id: userId, ...values,
        });
        if (error) throw error;
      }
    },
    onSuccess: (_data, status) => {
      setDirty(false);
      toast.success(status === "selesai" ? "Pemeriksaan selesai disimpan." : "Draf pemeriksaan tersimpan.");
      queryClient.invalidateQueries({ queryKey: ["review-detail", "tabel", id] });
      queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Gagal menyimpan pemeriksaan."),
  });

  if (isPending) return <p className="label-mono">Memuat detail pemeriksaan…</p>;
  if (error) return <p role="alert" className="text-sm text-amber">Gagal memuat detail: {error.message}</p>;
  if (!data?.table) return <p>Entri tidak ditemukan.</p>;
  const table = data.table;

  const locked = !canEdit || save.isPending;
  const fieldClass =
    "w-full rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50 disabled:opacity-60";
  const alertClass = "mb-4 rounded-lg bg-amber/10 p-3 text-sm text-amber ring-1 ring-amber/25";
  const tabClass = (active: boolean) =>
    `px-4 py-2 text-sm font-medium transition-colors ${active ? "border-b-2 border-teal text-teal" : "text-mist hover:text-ink"}`;
  const pairId = data.pairIds[activePair];

  return (
    <section>
      <PageHeading eyebrow={`v · tabel · ${table.code}`} title="Pemeriksaan terjemahan" right={<BackLink />} />

      <div className="panel mb-4 p-4">
        <label htmlFor="review-title" className="label-mono mb-2 block">Judul tabel</label>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg bg-paper/60 px-3 py-2">
            <div className="flex items-start gap-2 font-mono text-xs">
              <span className="flex-1">{table.title_en}</span>
              <CopyButton disabled={locked} onCopy={() => { setTitle(table.title_en ?? ""); setDirty(true); }} />
            </div>
            <div className="mt-1 text-xs text-mist">Anotator: {table.title_id || "(kosong)"}</div>
          </div>
          <input id="review-title" data-nav value={title} disabled={locked}
            onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
            onKeyDown={focusNextField}
            placeholder="Hasil pemeriksaan judul (ID)"
            className={fieldClass} />
        </div>
      </div>

      <div className="panel p-4">
        <div className="flex items-center gap-2">
          <div className="label-mono">Pratinjau tabel</div>
          <button type="button" tabIndex={-1} onClick={() => setShowPreview((v) => !v)}
            className="ml-auto rounded-lg px-3 py-1.5 font-mono text-[11px] text-mist ring-1 ring-line transition-colors hover:bg-ink/5">
            {showPreview ? "Sembunyikan" : "Tampilkan"}
          </button>
        </div>
        {showPreview && <div className="mt-3 grid gap-6 md:grid-cols-2">
          <HiTabTablePreview snapshot={table.original_table} translation={table.annotated_table}
            label="Sebelum validasi · EN + ID anotator (tebal)" maxHeightClass="max-h-[75vh]" />
          <HiTabTablePreview snapshot={applyCorrections(table.annotated_table, title, data.cells, cells)}
            label="Sesudah validasi" maxHeightClass="max-h-[75vh]" />
        </div>}
      </div>

      <div className="mt-6 flex gap-1 border-b border-line/70">
        <button type="button" onClick={() => setActiveTab("header")} className={tabClass(activeTab === "header")}>
          Header & kolom tabel
        </button>
        <button type="button" onClick={() => setActiveTab("qa")} className={tabClass(activeTab === "qa")}>
          Pasangan tanya-jawab <span className="font-mono text-xs text-mist">{data.pairIds.length}</span>
        </button>
      </div>

      {activeTab === "header" && <div className="mt-4">
        {!sampled && <p role="alert" className={alertClass}>Entri tidak termasuk sampel validasi.</p>}
        {!ready && <div role="alert" className={alertClass}>Terjemahan belum lengkap. Form pemeriksaan dikunci sampai anotator menyelesaikannya.</div>}
        {notAssigned && <div role="alert" className={alertClass}>Entri ini tidak ditugaskan kepada akun Validator Anda.</div>}
        {ownedByOther && <div role="alert" className={alertClass}>Entri sedang ditangani validator lain. Anda tidak dapat mengubahnya.</div>}
        {data.review?.status === "selesai" && <p className="mb-4 font-mono text-xs text-teal">Pemeriksaan sudah selesai. Ubah hasil lalu pilih “Simpan perbaikan” untuk memutakhirkan hasil.</p>}

        <div className="panel overflow-hidden">
          <div className="grid grid-cols-2 border-b border-line/70">
            <div className="label-mono border-r border-line/70 px-4 py-2">Sumber · EN</div>
            <div className="label-mono px-4 py-2">Hasil pemeriksaan · ID</div>
          </div>
          {data.cells.map((cell) => <div key={cell.id} className="grid grid-cols-2 text-sm">
            <div className="border-r border-b border-line/50 bg-paper/60 px-4 py-2.5">
              <div className="flex items-start gap-2">
                <span className="flex-1">
                  <span className="font-mono text-xs">{cell.source_text}</span>
                  <span className="ml-2 font-mono text-[10px] text-mist uppercase">{cell.kind}</span>
                </span>
                <CopyButton disabled={locked} onCopy={() => { setCells((prev) => ({ ...prev, [cell.id]: cell.source_text ?? "" })); setDirty(true); }} />
              </div>
              <div className="mt-1 text-xs text-mist">Anotator: {cell.target_text || "(kosong)"}</div>
            </div>
            <div className="border-b border-line/50 px-2 py-1.5">
              <textarea data-nav rows={2} value={cells[cell.id] ?? ""} disabled={locked}
                aria-label={`Hasil pemeriksaan: ${cell.source_text}`}
                onChange={(e) => { setCells((prev) => ({ ...prev, [cell.id]: e.target.value })); setDirty(true); }}
                onKeyDown={focusNextField}
                className={`${fieldClass} px-2 py-1.5 font-medium`} />
            </div>
          </div>)}
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <button type="button" disabled={locked}
              onClick={() => save.mutate("sedang_diperiksa")}
              className="rounded-lg px-4 py-2 text-sm font-semibold ring-1 ring-line transition-colors hover:bg-ink/5 disabled:opacity-50">
              {save.isPending ? "Menyimpan…" : "Simpan sementara"}
            </button>
            <button type="button" data-nav disabled={locked}
              onClick={() => save.mutate("selesai")}
              className="rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-primary-foreground ring-1 ring-teal/40 transition-colors hover:bg-teal/90 disabled:opacity-60">
              {data.review?.status === "selesai" ? "Simpan perbaikan" : "Selesaikan pemeriksaan"}
            </button>
            <span aria-live="polite" className="ml-auto font-mono text-[10px] text-mist">{dirty ? "Perubahan belum disimpan" : ""}</span>
          </div>
        </div>
      </div>}

      {activeTab === "qa" && <div className="mt-4">
        {pairId ? <>
          <div className="mb-3 flex items-center gap-2 font-mono text-xs text-mist">
            <span>Pasangan {activePair + 1} / {data.pairIds.length}</span>
            <button type="button" tabIndex={-1} disabled={activePair === 0}
              onClick={() => setActivePair((i) => Math.max(i - 1, 0))}
              className="ml-auto rounded-lg px-3 py-1.5 ring-1 ring-line hover:bg-ink/5 disabled:opacity-40">← Sebelumnya</button>
            <button type="button" tabIndex={-1} disabled={activePair >= data.pairIds.length - 1}
              onClick={() => setActivePair((i) => Math.min(i + 1, data.pairIds.length - 1))}
              className="rounded-lg px-3 py-1.5 ring-1 ring-line hover:bg-ink/5 disabled:opacity-40">Berikutnya →</button>
          </div>
          <QaReviewForm key={pairId} pairId={pairId} />
        </> : <div className="panel p-4 text-sm text-mist">Tabel ini belum memiliki pasangan tanya-jawab.</div>}
      </div>}

      <p className="mt-4 text-xs text-mist">Hasil validator disimpan terpisah dari terjemahan asli untuk menjaga jejak pemeriksaan.</p>
    </section>
  );
}
