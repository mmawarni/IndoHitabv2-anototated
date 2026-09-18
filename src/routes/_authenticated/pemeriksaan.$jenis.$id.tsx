import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeading } from "@/components/AppShell";
import { useCurrentUser } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

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

  const { data, isPending, error } = useQuery({
    queryKey: ["review-detail", jenis, id],
    enabled: allowed && (isTable || jenis === "pertanyaan"),
    queryFn: async () => {
      if (isTable) {
        const [t, c, r] = await Promise.all([
          supabase.from("tqa_tables").select("id, code, title_en, title_id").eq("id", id).maybeSingle(),
          supabase.from("table_cells").select("id, kind, position, source_text, target_text, status").eq("table_id", id).order("position"),
          supabase.from("table_reviews").select("id, reviewer_id, status, reviewed_title_id, corrected_cells").eq("table_id", id).maybeSingle(),
        ]);
        if (t.error) throw t.error;
        if (c.error) throw c.error;
        if (r.error) throw r.error;
        return { kind: "tabel" as const, table: t.data, cells: c.data ?? [], review: r.data };
      }
      const [q, r] = await Promise.all([
        supabase.from("qa_pairs").select("id, table_id, question_en, answer_en, question_id, answer_id, status").eq("id", id).maybeSingle(),
        supabase.from("qa_reviews").select("id, reviewer_id, status, reviewed_question_id, reviewed_answer_id").eq("qa_pair_id", id).maybeSingle(),
      ]);
      if (q.error) throw q.error;
      if (r.error) throw r.error;
      if (!q.data) return { kind: "pertanyaan" as const, pair: null, table: null, review: r.data };
      const t = await supabase.from("tqa_tables").select("code, title_en, title_id").eq("id", q.data.table_id).maybeSingle();
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
    }
    setDirty(false);
  }, [data]);

  const tableReady = data?.kind === "tabel" && !!data.table?.title_id?.trim() && data.cells.length > 0
    && data.cells.every((cell) => !!cell.target_text?.trim() && cell.status === "selesai");
  const qaReady = data?.kind === "pertanyaan" && !!data.pair?.question_id?.trim()
    && !!data.pair?.answer_id?.trim() && data.pair.status === "selesai";
  const ready = isTable ? tableReady : qaReady;
  const ownedByOther = !!data?.review?.reviewer_id && data.review.reviewer_id !== userId && !isAdmin;
  const canEdit = allowed && ready && !ownedByOther && !!userId;

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
        const values = { status, reviewed_question_id: question.trim(), reviewed_answer_id: answer.trim() };
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

  return (
    <section className="mx-auto max-w-5xl">
      <PageHeading eyebrow={`v · ${data.kind === "tabel" ? "tabel" : "pertanyaan"} · ${data.table.code}`}
        title="Pemeriksaan terjemahan"
        right={<Link to="/pemeriksaan" className="font-mono text-xs text-teal hover:underline">← Daftar pemeriksaan</Link>} />
      {!ready && <div role="alert" className="mb-5 rounded-xl bg-amber/10 p-4 text-sm text-amber ring-1 ring-amber/25">Terjemahan belum lengkap. Form pemeriksaan dikunci sampai anotator menyelesaikannya.</div>}
      {ownedByOther && <div role="alert" className="mb-5 rounded-xl bg-amber/10 p-4 text-sm text-amber ring-1 ring-amber/25">Entri sedang ditangani validator lain. Anda tidak dapat mengubahnya.</div>}
      {data.review?.status === "selesai" && <p className="mb-4 font-mono text-xs text-teal">Pemeriksaan sudah selesai. Ubah hasil lalu pilih “Simpan perbaikan” untuk memutakhirkan hasil.</p>}
      <div className="panel overflow-hidden">
        {data.kind === "tabel" ? <>
          <div className="border-b border-line/70 p-4">
            <label htmlFor="review-title" className="label-mono mb-2 block">Judul tabel · EN → ID</label>
            <div className="mb-2 rounded-lg bg-paper/60 p-3 text-sm">{data.table.title_en}</div>
            <div className="mb-2 text-xs text-mist">Terjemahan anotator: {data.table.title_id || "(kosong)"}</div>
            <input id="review-title" value={title} disabled={!canEdit || save.isPending}
              onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
              className="w-full rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50 disabled:opacity-60" />
          </div>
          {data.cells.map((cell) => <div key={cell.id} className="grid gap-3 border-b border-line/50 p-4 last:border-b-0 md:grid-cols-2">
            <div>
              <div className="label-mono mb-1">Sumber · {cell.kind}</div>
              <p className="text-sm">{cell.source_text}</p>
              <div className="mt-2 text-xs text-mist">Terjemahan anotator: {cell.target_text || "(kosong)"}</div>
            </div>
            <label className="block">
              <span className="label-mono mb-1 block">Hasil pemeriksaan</span>
              <textarea rows={2} value={cells[cell.id] ?? ""} disabled={!canEdit || save.isPending}
                onChange={(e) => { setCells((prev) => ({ ...prev, [cell.id]: e.target.value })); setDirty(true); }}
                className="w-full rounded-lg bg-frost p-3 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50 disabled:opacity-60" />
            </label>
          </div>)}
        </> : data.pair ? <div className="space-y-5 p-4">
          <div>
            <div className="label-mono mb-1">Pertanyaan · EN</div>
            <p className="mb-2 text-sm">{data.pair.question_en}</p>
            <div className="mb-2 text-xs text-mist">Terjemahan anotator: {data.pair.question_id || "(kosong)"}</div>
            <label htmlFor="review-question" className="label-mono mb-1 block">Hasil pemeriksaan pertanyaan · ID</label>
            <textarea id="review-question" rows={3} value={question} disabled={!canEdit || save.isPending}
              onChange={(e) => { setQuestion(e.target.value); setDirty(true); }}
              className="w-full rounded-lg bg-frost p-3 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50 disabled:opacity-60" />
          </div>
          <div>
            <div className="label-mono mb-1">Jawaban · EN</div>
            <p className="mb-2 text-sm">{data.pair.answer_en}</p>
            <div className="mb-2 text-xs text-mist">Terjemahan anotator: {data.pair.answer_id || "(kosong)"}</div>
            <label htmlFor="review-answer" className="label-mono mb-1 block">Hasil pemeriksaan jawaban · ID</label>
            <textarea id="review-answer" rows={3} value={answer} disabled={!canEdit || save.isPending}
              onChange={(e) => { setAnswer(e.target.value); setDirty(true); }}
              className="w-full rounded-lg bg-frost p-3 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50 disabled:opacity-60" />
          </div>
        </div> : null}
        <div className="flex flex-wrap items-center gap-3 border-t border-line/70 p-4">
          <button type="button" disabled={!canEdit || save.isPending}
            onClick={() => save.mutate("sedang_diperiksa")}
            className="rounded-lg px-4 py-2 text-sm font-medium ring-1 ring-line hover:bg-ink/5 disabled:opacity-40">
            {save.isPending ? "Menyimpan…" : "Simpan sementara"}
          </button>
          <button type="button" disabled={!canEdit || save.isPending}
            onClick={() => save.mutate("selesai")}
            className="rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-teal/90 disabled:opacity-40">
            {data.review?.status === "selesai" ? "Simpan perbaikan" : "Selesaikan pemeriksaan"}
          </button>
          <span aria-live="polite" className="ml-auto text-xs text-mist">{dirty ? "Perubahan belum disimpan" : ""}</span>
        </div>
      </div>
      <p className="mt-4 text-xs text-mist">Hasil validator disimpan terpisah dari terjemahan asli untuk menjaga jejak pemeriksaan.</p>
    </section>
  );
}
