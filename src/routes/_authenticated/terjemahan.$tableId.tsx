import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeading } from "@/components/AppShell";
import { useCurrentUser } from "@/hooks/useAuth";
import { HiTabTablePreview } from "@/components/HiTabTablePreview";
import { HiTabQaLogic } from "@/components/HiTabQaLogic";
import { useWorkOpen } from "@/hooks/useWorkOpen";

export const Route = createFileRoute("/_authenticated/terjemahan/$tableId")({
  head: () => ({
    meta: [
      { title: "Penerjemahan Tabel — HiTab TQA" },
      {
        name: "description",
        content:
          "Terjemahkan header dan kolom tabel HiTab TQA berdampingan dengan sumbernya, lalu lanjutkan ke pasangan tanya-jawab.",
      },
      { property: "og:title", content: "Penerjemahan Tabel — HiTab TQA" },
      {
        property: "og:description",
        content: "Terjemahkan header, kolom, dan pasangan tanya-jawab tabel HiTab TQA.",
      },
    ],
  }),
  component: TranslationWorkspace,
});

type CellDraft = Record<string, string>;
type PairDraft = Record<string, { question: string; answer: string }>;

function TranslationWorkspace() {
  const { tableId } = Route.useParams();
  const { userId, isAdmin, isAnotator, rolesLoading, rolesError } = useCurrentUser();
  const allowed = isAdmin || isAnotator;
  const queryClient = useQueryClient();

  const [cellDrafts, setCellDrafts] = useState<CellDraft>({});
  const [titleDraft, setTitleDraft] = useState("");
  const [pairDrafts, setPairDrafts] = useState<PairDraft>({});
  const [activePair, setActivePair] = useState(0);

  const { data, isLoading } = useQuery({
    queryKey: ["tabel", tableId],
    enabled: allowed,
    queryFn: async () => {
      const [table, cells, pairs] = await Promise.all([
        supabase
          .from("tqa_tables")
          .select("id, code, title_en, title_id, original_table, annotated_table, annotate_flag, original_table_id, annotator_id")
          .eq("id", tableId)
          .maybeSingle(),
        supabase
          .from("table_cells")
          .select("id, kind, position, source_text, target_text, status")
          .eq("table_id", tableId)
          .order("position"),
        supabase
          .from("qa_pairs")
          .select("id, position, question_en, answer_en, question_id, answer_id, status, original_qa, original_question_id, annotate_flag, annotator_id")
          .eq("annotate_flag",1)
          .eq("table_id", tableId)
          .order("position"),
      ]);
      if (table.error) throw table.error;
      if (cells.error) throw cells.error;
      if (pairs.error) throw pairs.error;
      const visiblePairs = isAdmin ? (pairs.data ?? []) : (pairs.data ?? []).filter((p) => p.annotator_id === userId);
      return { table: table.data, cells: cells.data ?? [], pairs: visiblePairs };
    },
  });

  useEffect(() => {
    if (!data) return;
    setTitleDraft(data.table?.title_id ?? "");
    setCellDrafts(
      Object.fromEntries(data.cells.map((cell) => [cell.id, cell.target_text ?? ""])) as CellDraft,
    );
    setPairDrafts(
      Object.fromEntries(
        data.pairs.map((pair) => [
          pair.id,
          { question: pair.question_id ?? "", answer: pair.answer_id ?? "" },
        ]),
      ) as PairDraft,
    );
    setActivePair(0);
  }, [data]);

  const saveCells = useMutation({
    mutationFn: async () => {
      if (!data) return;
      const changes: Record<string,string> = {};
      for (const cell of data.cells) {
        const value=(cellDrafts[cell.id] ?? "").trim();
        if (value !== (cell.target_text ?? "")) changes[cell.id]=value;
      }
      const {error}=await supabase.rpc("hitab_save_table_translation",{
        _table_id:tableId,_title:titleDraft.trim(),_cells:changes,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Terjemahan header & kolom tersimpan.");
      queryClient.invalidateQueries({ queryKey: ["tabel", tableId] });
      queryClient.invalidateQueries({ queryKey: ["progres"] });
      queryClient.invalidateQueries({ queryKey: ["daftar-tabel"] });
      queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal menyimpan."),
  });

  const savePair = useMutation({
    mutationFn: async (pairId: string) => {
      const draft = pairDrafts[pairId];
      const question = (draft?.question ?? "").trim();
      const answer = (draft?.answer ?? "").trim();
      const { error } = await supabase
        .from("qa_pairs")
        .update({
          question_id: question || null,
          answer_id: answer || null,
        })
        .eq("id", pairId).eq("annotate_flag",1);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Pasangan tanya-jawab tersimpan.");
      queryClient.invalidateQueries({ queryKey: ["tabel", tableId] });
      queryClient.invalidateQueries({ queryKey: ["progres"] });
      queryClient.invalidateQueries({ queryKey: ["daftar-tabel"] });
      queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal menyimpan."),
  });

  useWorkOpen("table", tableId, allowed && !!data?.table && data.table.annotate_flag === 1 && (isAdmin || data.table.annotator_id === userId));
  useWorkOpen("qa", data?.pairs[activePair]?.id, allowed && !!data?.table && data.pairs[activePair]?.annotate_flag === 1 && (isAdmin || data.pairs[activePair]?.annotator_id === userId));

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert">Gagal memuat peran.</p>;
  if (!allowed) return <p role="alert">Halaman ini hanya untuk Anotator atau Admin.</p>;
  if (isLoading || !data) return <span className="label-mono">Memuat tabel…</span>;
  if (!data.table) {
    return (
      <div className="text-sm text-mist">
        Tabel tidak ditemukan.{" "}
        <Link to="/terjemahan" className="text-teal hover:underline">
          Kembali ke daftar
        </Link>
      </div>
    );
  }

  const pair = data.pairs[activePair];
  const pairDraft = pair ? (pairDrafts[pair.id] ?? { question: "", answer: "" }) : null;
  const tableCanEdit = data.table.annotate_flag === 1 && (isAdmin || data.table.annotator_id === userId);
  const pairCanEdit = !!pair && pair.annotate_flag === 1 && (isAdmin || pair.annotator_id === userId);

  return (
    <section>
      <PageHeading
        eyebrow={`c · ${data.table.code}`}
        title="Header tabel & pasangan QA"
        right={
          <Link to="/terjemahan" className="font-mono text-[11px] text-teal hover:underline">
            ← daftar tabel
          </Link>
        }
      />

      {!tableCanEdit && <p role="status" className="mb-4 rounded-lg bg-amber/10 p-3 text-sm">Tabel ini tidak ditugaskan kepada Anda atau tidak termasuk sampel tabel. QA yang ditugaskan kepada Anda tetap dapat diterjemahkan.</p>}
      <div className="panel mb-4 p-4">
        <div className="label-mono mb-2">Judul tabel</div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg bg-paper/60 px-3 py-2 font-mono text-xs">
            {data.table.title_en}
          </div>
          <input
            value={titleDraft}
            disabled={!tableCanEdit}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="Terjemahan judul (ID)"
            className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
          />
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="grid grid-cols-2 border-b border-line/70">
          <div className="label-mono border-r border-line/70 px-4 py-2">Sumber · EN</div>
          <div className="label-mono px-4 py-2">Target · ID</div>
        </div>
        {data.cells.map((cell) => (
          <div key={cell.id} className="grid grid-cols-2 text-sm">
            <div className="border-r border-b border-line/50 bg-paper/60 px-4 py-2.5">
              <span className="font-mono text-xs">{cell.source_text}</span>
              <span className="ml-2 font-mono text-[10px] text-mist uppercase">{cell.kind}</span>
            </div>
            <div className="border-b border-line/50 px-2 py-1.5">
              <input
                value={cellDrafts[cell.id] ?? ""}
                disabled={!tableCanEdit}
                onChange={(e) =>
                  setCellDrafts((prev) => ({ ...prev, [cell.id]: e.target.value }))
                }
                placeholder="Terjemahan…"
                className="w-full rounded-lg bg-frost px-2 py-1.5 text-sm font-medium ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
              />
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            onClick={() => saveCells.mutate()}
            disabled={saveCells.isPending || !tableCanEdit}
            className="rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-primary-foreground ring-1 ring-teal/40 transition-colors hover:bg-teal/90 disabled:opacity-60"
          >
            {saveCells.isPending ? "Menyimpan…" : "Simpan header & kolom"}
          </button>
          <span className="ml-auto font-mono text-[10px] text-mist">
            {data.cells.filter((c) => (cellDrafts[c.id] ?? "").trim()).length}/{data.cells.length}{" "}
            terisi
          </span>
        </div>
      </div>

      <div className="panel mt-6 space-y-5 p-4">
        <HiTabTablePreview snapshot={data.table.original_table} label="Tabel asli (EN)" />
        <HiTabTablePreview snapshot={data.table.annotated_table} label="Tabel setelah anotasi (ID) · tersimpan" />
        <p className="text-xs text-mist">Struktur hierarki dan merged regions berasal dari JSON asli; penyimpanan baru memperbarui snapshot terjemahan.</p>
      </div>

      {pair && pairDraft ? (
        <div className="relative mt-6">
          <div className="prism prism-animate absolute -inset-1 rounded-2xl opacity-60 blur-lg" />
          <div className="panel relative p-4">
            <div className="mb-3 flex items-center gap-2">
              <div className="label-mono">Pasangan pertanyaan–jawaban</div>
              <span className="ml-auto font-mono text-[11px] text-mist">
                {activePair + 1} / {data.pairs.length}
              </span>
            </div>

            <div className="mb-2 font-mono text-[11px] text-mist">ID asli QA: {pair.original_question_id ?? "Belum diimpor"}</div>
            <HiTabQaLogic original={pair.original_qa} />
            <div className="mb-1 mt-4 font-mono text-xs text-mist">Q · EN</div>
            <div className="mb-3 text-sm">{pair.question_en}</div>
            <div className="mb-1 font-mono text-xs text-mist">Q · ID</div>
            <textarea
              value={pairDraft.question}
              onChange={(e) =>
                setPairDrafts((prev) => ({
                  ...prev,
                  [pair.id]: { ...pairDraft, question: e.target.value },
                }))
              }
              rows={2}
              disabled={!pairCanEdit}
              placeholder="Terjemahan pertanyaan…"
              className="mb-4 w-full rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
            />

            <div className="mb-1 font-mono text-xs text-mist">A · EN</div>
            <div className="mb-3 text-sm">{pair.answer_en}</div>
            <div className="mb-1 font-mono text-xs text-mist">A · ID</div>
            <textarea
              value={pairDraft.answer}
              onChange={(e) =>
                setPairDrafts((prev) => ({
                  ...prev,
                  [pair.id]: { ...pairDraft, answer: e.target.value },
                }))
              }
              rows={2}
              disabled={!pairCanEdit}
              placeholder="Terjemahan jawaban…"
              className="mb-4 w-full rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
            />

            <div className="flex items-center gap-2">
              <button
                onClick={() => savePair.mutate(pair.id)}
                disabled={savePair.isPending || !pairCanEdit}
                className="rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-primary-foreground ring-1 ring-teal/40 transition-colors hover:bg-teal/90 disabled:opacity-60"
              >
                {savePair.isPending ? "Menyimpan…" : "Simpan"}
              </button>
              <button
                onClick={() =>
                  setActivePair((index) => Math.min(index + 1, data.pairs.length - 1))
                }
                disabled={activePair >= data.pairs.length - 1}
                className="rounded-lg px-4 py-2 text-sm font-semibold ring-1 ring-line transition-colors hover:bg-ink/5 disabled:opacity-50"
              >
                Berikutnya
              </button>
              <span className="ml-auto font-mono text-[10px] text-mist">
                status: {pair.status}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="panel mt-6 p-4 text-sm text-mist">
          Tabel ini belum memiliki pasangan tanya-jawab.
        </div>
      )}
    </section>
  );
}
