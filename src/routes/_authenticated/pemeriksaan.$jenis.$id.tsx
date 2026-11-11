import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeading } from "@/components/AppShell";
import { useCurrentUser } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { HiTabTablePreview } from "@/components/HiTabTablePreview";
import { HiTabQaLogic } from "@/components/HiTabQaLogic";
import { useWorkOpen } from "@/hooks/useWorkOpen";
import { CopyButton, focusNextField } from "@/components/TranslationFields";

export const Route = createFileRoute("/_authenticated/pemeriksaan/$jenis/$id")({
  head: () => ({ meta: [{ title: "Form Pemeriksaan — HiTab TQA" }] }),
  component: ReviewDetail,
});

type ReviewStatus = "sedang_diperiksa" | "selesai";
type CellCorrections = Record<string, string>;

function ReviewDetail() {
  const { jenis, id } = Route.useParams();
  const isTable = jenis === "tabel";
  const { userId, isValidator, isAdmin, rolesLoading, rolesError } = useCurrentUser();
  const allowed = isValidator || isAdmin;
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [cells, setCells] = useState<CellCorrections>({});
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [dirty, setDirty] = useState(false);
  const [logicConfirmed, setLogicConfirmed] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  const { data, isPending, error } = useQuery({
    queryKey: ["review-detail", jenis, id],
    enabled: allowed && (isTable || jenis === "pertanyaan"),
    queryFn: async () => {
      if (isTable) {
        const [t, c, r] = await Promise.all([
          supabase.from("tqa_tables").select("id, code, title_en, title_id, original_table, annotated_table, validated_table, annotate_flag, validator_id").eq("id", id).maybeSingle(),
          supabase.from("table_cells").select("id, kind, position, source_text, target_text, status").eq("table_id", id).order("position"),
          supabase.from("table_reviews").select("id, reviewer_id, status, reviewed_title_id, corrected_cells").eq("table_id", id).maybeSingle(),
        ]);
        if (t.error) throw t.error;
        if (c.error) throw c.error;
        if (r.error) throw r.error;
        return { kind: "tabel" as const, table: t.data, cells: c.data ?? [], review: r.data };
      }
      const [q, r] = await Promise.all([
        supabase.from("qa_pairs").select("id, table_id, question_en, answer_en, question_id, answer_id, status, original_qa, annotated_qa, validated_qa, annotate_flag, original_question_id, validator_id").eq("id", id).maybeSingle(),
        supabase.from("qa_reviews").select("id, reviewer_id, status, reviewed_question_id, reviewed_answer_id, logic_confirmed").eq("qa_pair_id", id).maybeSingle(),
      ]);
      if (q.error) throw q.error;
      if (r.error) throw r.error;
      if (!q.data) return { kind: "pertanyaan" as const, pair: null, table: null, review: r.data };
      const t = await supabase.from("tqa_tables").select("code, title_en, title_id, original_table").eq("id", q.data.table_id).maybeSingle();
      if (t.error) throw t.error;
      return { kind: "pertanyaan" as const, pair: q.data, table: t.data, review: r.data };
    },
  });

  useEffect(() => {
    if (!data) return;
    if (data.kind === "tabel") {
      setTitle(data.review?.reviewed_title_id ?? data.table?.title_id ?? "");
      const saved = data.review?.corrected_cells;
      const savedCells: CellCorrections = saved && typeof saved === "object" && !Array.isArray(saved)
        ? Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
      setCells(Object.fromEntries(data.cells.map((cell) => [cell.id, savedCells[cell.id] ?? cell.target_text ?? ""])));
    } else {
      setQuestion(data.review?.reviewed_question_id ?? data.pair?.question_id ?? "");
      setAnswer(data.review?.reviewed_answer_id ?? data.pair?.answer_id ?? "");
      setLogicConfirmed(data.review?.logic_confirmed ?? false);
    }
    setDirty(false);
  }, [data]);

  const tableReady = data?.kind === "tabel" && !!data.table?.title_id?.trim() && data.cells.length > 0
    && data.cells.every((cell) => !!cell.target_text?.trim() && cell.status === "selesai");
  const qaReady = data?.kind === "pertanyaan" && !!data.pair?.question_id?.trim()
    && !!data.pair?.answer_id?.trim() && data.pair.status === "selesai";
  const sampled = data?.kind === "tabel" ? data.table?.annotate_flag === 1 : data?.pair?.annotate_flag === 1;
  const ready = sampled && (isTable ? tableReady : qaReady);
  const assignedValidator = data?.kind === "tabel" ? data.table?.validator_id : data?.pair?.validator_id;
  const notAssigned = !isAdmin && assignedValidator !== userId;
  const ownedByOther = !!data?.review?.reviewer_id && data.review.reviewer_id !== userId && !isAdmin;
  const canEdit = allowed && ready && !notAssigned && !ownedByOther && !!userId;
  useWorkOpen(isTable ? "table_review" : "qa_review", id, canEdit);

  const save = useMutation({
    mutationFn: async (status: ReviewStatus) => {
      if (!data || !canEdit || !userId) throw new Error("Pemeriksaan tidak tersedia untuk akun atau entri ini.");
      if (data.kind === "tabel") {
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
      } else {
        if (status === "selesai" && (!question.trim() || !answer.trim())) {
          throw new Error("Hasil pemeriksaan pertanyaan dan jawaban wajib diisi.");
        }
        if (status === "selesai" && data.pair.original_qa && !logicConfirmed) {
          throw new Error("Periksa answer asli, aggregation, formula, dan linked cells terlebih dahulu.");
        }
        const values = { status, reviewed_question_id: question.trim(), reviewed_answer_id: answer.trim(), logic_confirmed: logicConfirmed };
        if (data.review) {
          const { data: updated, error } = await supabase.from("qa_reviews")
            .update(values).eq("id", data.review.id).select("id").maybeSingle();
          if (error) throw error;
          if (!updated) throw new Error("Pemeriksaan telah berubah. Muat ulang halaman.");
        } else {
          const { error } = await supabase.from("qa_reviews").insert({
            qa_pair_id: id, reviewer_id: userId, ...values,
          });
          if (error) throw error;
        }
      }
    },
    onSuccess: (_data, status) => {
      setDirty(false);
      toast.success(status === "selesai" ? "Pemeriksaan selesai disimpan." : "Draf pemeriksaan tersimpan.");
      queryClient.invalidateQueries({ queryKey: ["review-detail", jenis, id] });
      queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Gagal menyimpan pemeriksaan."),
  });

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert" className="text-sm text-amber">Gagal memuat peran. Muat ulang halaman.</p>;
  if (!allowed) return <p role="alert" className="text-sm text-mist">Halaman ini hanya untuk Validator atau Admin.</p>;
  if (jenis !== "tabel" && jenis !== "pertanyaan") return <p>Jenis pemeriksaan tidak dikenal.</p>;
  if (isPending) return <p className="label-mono">Memuat detail pemeriksaan…</p>;
  if (error) return <p role="alert" className="text-sm text-amber">Gagal memuat detail: {error.message}</p>;
  if (!data?.table || (data.kind === "tabel" ? !data.table : !data.pair)) return <p>Entri tidak ditemukan.</p>;

  const locked = !canEdit || save.isPending;
  const fieldClass =
    "w-full rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50 disabled:opacity-60";
  const alertClass = "mb-4 rounded-lg bg-amber/10 p-3 text-sm text-amber ring-1 ring-amber/25";
  const actions = (
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
  );
  const preview = (snapshots: { snapshot: Json | null | undefined; label: string }[]) => (
    <div className="panel mb-4 p-4">
      <div className="flex items-center gap-2">
        <div className="label-mono">Pratinjau tabel</div>
        <button type="button" tabIndex={-1} onClick={() => setShowPreview((v) => !v)}
          className="ml-auto rounded-lg px-3 py-1.5 font-mono text-[11px] text-mist ring-1 ring-line transition-colors hover:bg-ink/5">
          {showPreview ? "Sembunyikan" : "Tampilkan"}
        </button>
      </div>
      {showPreview && <div className={`mt-3 grid gap-6 ${snapshots.length > 1 ? "md:grid-cols-2" : ""}`}>
        {snapshots.map((s) => <HiTabTablePreview key={s.label} snapshot={s.snapshot} label={s.label} maxHeightClass="max-h-[75vh]" />)}
      </div>}
    </div>
  );

  return (
    <section>
      <PageHeading eyebrow={`v · ${data.kind === "tabel" ? "tabel" : "pertanyaan"} · ${data.table.code}`}
        title="Pemeriksaan terjemahan"
        right={<Link to="/pemeriksaan" className="font-mono text-[11px] text-teal hover:underline">← daftar pemeriksaan</Link>} />
      {!sampled && <p role="alert" className={alertClass}>Entri tidak termasuk sampel validasi.</p>}
      {!ready && <div role="alert" className={alertClass}>Terjemahan belum lengkap. Form pemeriksaan dikunci sampai anotator menyelesaikannya.</div>}
      {notAssigned && <div role="alert" className={alertClass}>Entri ini tidak ditugaskan kepada akun Validator Anda.</div>}
      {ownedByOther && <div role="alert" className={alertClass}>Entri sedang ditangani validator lain. Anda tidak dapat mengubahnya.</div>}
      {data.review?.status === "selesai" && <p className="mb-4 font-mono text-xs text-teal">Pemeriksaan sudah selesai. Ubah hasil lalu pilih “Simpan perbaikan” untuk memutakhirkan hasil.</p>}

      {data.kind === "tabel" ? <>
        <div className="panel mb-4 p-4">
          <label htmlFor="review-title" className="label-mono mb-2 block">Judul tabel</label>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg bg-paper/60 px-3 py-2">
              <div className="flex items-start gap-2 font-mono text-xs">
                <span className="flex-1">{data.table.title_en}</span>
                <CopyButton disabled={locked} onCopy={() => { setTitle(data.table?.title_en ?? ""); setDirty(true); }} />
              </div>
              <div className="mt-1 text-xs text-mist">Anotator: {data.table.title_id || "(kosong)"}</div>
            </div>
            <input id="review-title" data-nav value={title} disabled={locked}
              onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
              onKeyDown={focusNextField}
              placeholder="Hasil pemeriksaan judul (ID)"
              className={fieldClass} />
          </div>
        </div>

        {preview([
          { snapshot: data.table.original_table, label: "Tabel sumber asli" },
          { snapshot: data.table.annotated_table, label: "Tabel hasil anotator" },
          ...(data.table.validated_table ? [{ snapshot: data.table.validated_table, label: "Snapshot validasi sebelumnya" }] : []),
        ])}

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
          {actions}
        </div>
      </> : data.pair ? <>
        {preview([{ snapshot: data.table.original_table, label: "Tabel sumber untuk verifikasi jawaban" }])}
        <div className="panel p-4">
          <div className="mb-2 font-mono text-[11px] text-mist">ID asli QA: {data.pair.original_question_id ?? "Belum diimpor"}</div>
          <HiTabQaLogic original={data.pair.original_qa} collapsible defaultOpen />

          <div className="mb-1 mt-4 font-mono text-xs text-mist">Q · EN</div>
          <div className="mb-1 flex items-start gap-2 text-sm">
            <span className="flex-1">{data.pair.question_en}</span>
            <CopyButton disabled={locked} onCopy={() => { setQuestion(data.pair?.question_en ?? ""); setDirty(true); }} />
          </div>
          <div className="mb-3 text-xs text-mist">Anotator: {data.pair.question_id || "(kosong)"}</div>
          <label htmlFor="review-question" className="mb-1 block font-mono text-xs text-mist">Q · ID · hasil pemeriksaan</label>
          <textarea id="review-question" data-nav rows={2} value={question} disabled={locked}
            onChange={(e) => { setQuestion(e.target.value); setDirty(true); }}
            onKeyDown={focusNextField}
            className={`${fieldClass} mb-4`} />

          <div className="mb-1 font-mono text-xs text-mist">A · EN</div>
          <div className="mb-1 flex items-start gap-2 text-sm">
            <span className="flex-1">{data.pair.answer_en}</span>
            <CopyButton disabled={locked} onCopy={() => { setAnswer(data.pair?.answer_en ?? ""); setDirty(true); }} />
          </div>
          <div className="mb-3 text-xs text-mist">Anotator: {data.pair.answer_id || "(kosong)"}</div>
          <label htmlFor="review-answer" className="mb-1 block font-mono text-xs text-mist">A · ID · hasil pemeriksaan</label>
          <textarea id="review-answer" data-nav rows={2} value={answer} disabled={locked}
            onChange={(e) => { setAnswer(e.target.value); setDirty(true); }}
            onKeyDown={focusNextField}
            className={`${fieldClass} mb-4`} />

          {data.pair.original_qa && <label className="flex items-start gap-2 rounded-lg bg-teal/5 p-3 text-sm">
            <input type="checkbox" checked={logicConfirmed} disabled={locked}
              onChange={(e)=>{setLogicConfirmed(e.target.checked);setDirty(true);}} />
            Saya sudah memeriksa kesesuaian terjemahan dengan jawaban asli, aggregation, formula, dan linked cells.
          </label>}
        </div>
        <div className="panel mt-4 overflow-hidden">{actions}</div>
      </> : null}
      <p className="mt-4 text-xs text-mist">Hasil validator disimpan terpisah dari terjemahan asli untuk menjaga jejak pemeriksaan.</p>
    </section>
  );
}
