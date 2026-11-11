import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useCurrentUser } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { HiTabTablePreview } from "@/components/HiTabTablePreview";
import { HiTabQaLogic } from "@/components/HiTabQaLogic";
import { useWorkOpen } from "@/hooks/useWorkOpen";
import { CopyButton, focusNextField } from "@/components/TranslationFields";

type ReviewStatus = "sedang_diperiksa" | "selesai";

/**
 * Validator form for one QA pair (qa_reviews). Used by the "pertanyaan" review page
 * and by the QA tab of the table review page, so both follow the same rules.
 */
export function QaReviewForm({ pairId, withTablePreview = false }: {
  pairId: string;
  /** Show the source table (EN + annotator ID) above the form. */
  withTablePreview?: boolean;
}) {
  const { userId, isValidator, isAdmin } = useCurrentUser();
  const allowed = isValidator || isAdmin;
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [dirty, setDirty] = useState(false);
  const [logicConfirmed, setLogicConfirmed] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  const { data, isPending, error } = useQuery({
    queryKey: ["review-detail", "pertanyaan", pairId],
    enabled: allowed,
    queryFn: async () => {
      const [q, r] = await Promise.all([
        supabase.from("qa_pairs").select("id, table_id, question_en, answer_en, question_id, answer_id, status, original_qa, annotated_qa, validated_qa, annotate_flag, original_question_id, validator_id").eq("id", pairId).maybeSingle(),
        supabase.from("qa_reviews").select("id, reviewer_id, status, reviewed_question_id, reviewed_answer_id, logic_confirmed").eq("qa_pair_id", pairId).maybeSingle(),
      ]);
      if (q.error) throw q.error;
      if (r.error) throw r.error;
      if (!q.data) return { pair: null, table: null, review: r.data };
      const t = await supabase.from("tqa_tables").select("code, title_en, title_id, original_table, annotated_table").eq("id", q.data.table_id).maybeSingle();
      if (t.error) throw t.error;
      return { pair: q.data, table: t.data, review: r.data };
    },
  });

  useEffect(() => {
    if (!data) return;
    setQuestion(data.review?.reviewed_question_id ?? data.pair?.question_id ?? "");
    setAnswer(data.review?.reviewed_answer_id ?? data.pair?.answer_id ?? "");
    setLogicConfirmed(data.review?.logic_confirmed ?? false);
    setDirty(false);
  }, [data]);

  const sampled = data?.pair?.annotate_flag === 1;
  const ready = sampled && !!data?.pair?.question_id?.trim()
    && !!data?.pair?.answer_id?.trim() && data?.pair?.status === "selesai";
  const notAssigned = !isAdmin && data?.pair?.validator_id !== userId;
  const ownedByOther = !!data?.review?.reviewer_id && data.review.reviewer_id !== userId && !isAdmin;
  const canEdit = allowed && ready && !notAssigned && !ownedByOther && !!userId;
  useWorkOpen("qa_review", pairId, canEdit);

  const save = useMutation({
    mutationFn: async (status: ReviewStatus) => {
      if (!data?.pair || !canEdit || !userId) throw new Error("Pemeriksaan tidak tersedia untuk akun atau entri ini.");
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
          qa_pair_id: pairId, reviewer_id: userId, ...values,
        });
        if (error) throw error;
      }
    },
    onSuccess: (_data, status) => {
      setDirty(false);
      toast.success(status === "selesai" ? "Pemeriksaan selesai disimpan." : "Draf pemeriksaan tersimpan.");
      queryClient.invalidateQueries({ queryKey: ["review-detail", "pertanyaan", pairId] });
      queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Gagal menyimpan pemeriksaan."),
  });

  if (isPending) return <p className="label-mono">Memuat pasangan tanya-jawab…</p>;
  if (error) return <p role="alert" className="text-sm text-amber">Gagal memuat detail: {error.message}</p>;
  if (!data?.pair || !data.table) return <p className="text-sm text-mist">Pasangan tanya-jawab tidak ditemukan.</p>;
  const pair = data.pair;

  const locked = !canEdit || save.isPending;
  const fieldClass =
    "w-full rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50 disabled:opacity-60";
  const alertClass = "mb-4 rounded-lg bg-amber/10 p-3 text-sm text-amber ring-1 ring-amber/25";

  return (
    <div>
      {!sampled && <p role="alert" className={alertClass}>Entri tidak termasuk sampel validasi.</p>}
      {!ready && <div role="alert" className={alertClass}>Terjemahan belum lengkap. Form pemeriksaan dikunci sampai anotator menyelesaikannya.</div>}
      {notAssigned && <div role="alert" className={alertClass}>Entri ini tidak ditugaskan kepada akun Validator Anda.</div>}
      {ownedByOther && <div role="alert" className={alertClass}>Entri sedang ditangani validator lain. Anda tidak dapat mengubahnya.</div>}
      {data.review?.status === "selesai" && <p className="mb-4 font-mono text-xs text-teal">Pemeriksaan sudah selesai. Ubah hasil lalu pilih “Simpan perbaikan” untuk memutakhirkan hasil.</p>}

      {withTablePreview && <div className="panel mb-4 p-4">
        <div className="flex items-center gap-2">
          <div className="label-mono">Pratinjau tabel</div>
          <button type="button" tabIndex={-1} onClick={() => setShowPreview((v) => !v)}
            className="ml-auto rounded-lg px-3 py-1.5 font-mono text-[11px] text-mist ring-1 ring-line transition-colors hover:bg-ink/5">
            {showPreview ? "Sembunyikan" : "Tampilkan"}
          </button>
        </div>
        {showPreview && <div className="mt-3">
          <HiTabTablePreview snapshot={data.table.original_table} translation={data.table.annotated_table}
            label="Tabel sumber untuk verifikasi jawaban · EN + ID (tebal)" maxHeightClass="max-h-[75vh]" />
        </div>}
      </div>}

      <div className="panel p-4">
        <div className="mb-2 font-mono text-[11px] text-mist">ID asli QA: {pair.original_question_id ?? "Belum diimpor"}</div>
        <HiTabQaLogic original={pair.original_qa} collapsible />

        <div className="mb-1 mt-4 font-mono text-xs text-mist">Q · EN</div>
        <div className="mb-1 flex items-start gap-2 text-sm">
          <span className="flex-1">{pair.question_en}</span>
          <CopyButton disabled={locked} onCopy={() => { setQuestion(pair.question_en ?? ""); setDirty(true); }} />
        </div>
        <div className="mb-3 text-xs text-mist">Anotator: {pair.question_id || "(kosong)"}</div>
        <label htmlFor={`review-question-${pairId}`} className="mb-1 block font-mono text-xs text-mist">Q · ID · hasil pemeriksaan</label>
        <textarea id={`review-question-${pairId}`} data-nav rows={2} value={question} disabled={locked}
          onChange={(e) => { setQuestion(e.target.value); setDirty(true); }}
          onKeyDown={focusNextField}
          className={`${fieldClass} mb-4`} />

        <div className="mb-1 font-mono text-xs text-mist">A · EN</div>
        <div className="mb-1 flex items-start gap-2 text-sm">
          <span className="flex-1">{pair.answer_en}</span>
          <CopyButton disabled={locked} onCopy={() => { setAnswer(pair.answer_en ?? ""); setDirty(true); }} />
        </div>
        <div className="mb-3 text-xs text-mist">Anotator: {pair.answer_id || "(kosong)"}</div>
        <label htmlFor={`review-answer-${pairId}`} className="mb-1 block font-mono text-xs text-mist">A · ID · hasil pemeriksaan</label>
        <textarea id={`review-answer-${pairId}`} data-nav rows={2} value={answer} disabled={locked}
          onChange={(e) => { setAnswer(e.target.value); setDirty(true); }}
          onKeyDown={focusNextField}
          className={`${fieldClass} mb-4`} />

        {pair.original_qa && <label className="flex items-start gap-2 rounded-lg bg-teal/5 p-3 text-sm">
          <input type="checkbox" checked={logicConfirmed} disabled={locked}
            onChange={(e) => { setLogicConfirmed(e.target.checked); setDirty(true); }} />
          Saya sudah memeriksa kesesuaian terjemahan dengan jawaban asli, aggregation, formula, dan linked cells.
        </label>}

        <div className="mt-4 flex flex-wrap items-center gap-2">
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
    </div>
  );
}
