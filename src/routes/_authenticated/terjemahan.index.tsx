import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeading } from "@/components/AppShell";
import { useCurrentUser } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/terjemahan/")({
  head: () => ({
    meta: [
      { title: "Ruang Kerja Terjemahan — HiTab TQA" },
      {
        name: "description",
        content:
          "Daftar tabel dataset HiTab TQA yang siap diterjemahkan beserta progres header, kolom, dan pasangan tanya-jawab.",
      },
      { property: "og:title", content: "Ruang Kerja Terjemahan — HiTab TQA" },
      {
        property: "og:description",
        content: "Daftar tabel dataset HiTab TQA yang siap diterjemahkan.",
      },
    ],
  }),
  component: WorkspaceListPage,
});

function WorkspaceListPage() {
  const { userId, isAdmin, isAnotator, rolesLoading, rolesError } = useCurrentUser();
  const allowed = isAdmin || isAnotator;
  const { data, isLoading } = useQuery({
    queryKey: ["daftar-tabel"],
    enabled: allowed,
    queryFn: async () => {
      const [tables, cells, qa] = await Promise.all([
        supabase.from("tqa_tables").select("id, code, title_en, title_id, annotate_flag, annotator_id").order("code"),
        supabase.from("table_cells").select("id, table_id, target_text"),
        supabase.from("qa_pairs").select("id, table_id, question_id, answer_id, annotate_flag, annotator_id"),
      ]);
      if (tables.error) throw tables.error;
      if (cells.error) throw cells.error;
      if (qa.error) throw qa.error;
      return { tables: tables.data ?? [], cells: cells.data ?? [], qa: qa.data ?? [] };
    },
  });

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert">Gagal memuat peran.</p>;
  if (!allowed) return <p role="alert">Halaman ini hanya untuk Anotator atau Admin.</p>;
  if (isLoading || !data) return <span className="label-mono">Memuat daftar tabel…</span>;

  return (
    <section>
      <PageHeading
        eyebrow="c · ruang kerja terjemahan"
        title="Pilih tabel dataset"
        right={<div className="font-mono text-[11px] text-mist">{data.tables.length} tabel</div>}
      />

      <div className="panel overflow-hidden">
        <div className="grid grid-cols-[7rem_1fr_8rem_8rem] gap-3 border-b border-line/70 px-4 py-2">
          <span className="label-mono">Kode</span>
          <span className="label-mono">Judul sumber</span>
          <span className="label-mono">Header/kolom</span>
          <span className="label-mono">Pasangan QA</span>
        </div>

        {data.tables.filter((t) => {
          const tableAssigned = isAdmin || (t.annotate_flag === 1 && t.annotator_id === userId);
          const qaAssigned = data.qa.some((q)=>q.table_id===t.id && q.annotate_flag===1 && (isAdmin || q.annotator_id===userId));
          return tableAssigned || qaAssigned;
        }).map((table) => {
          const cells = data.cells.filter((c) => c.table_id === table.id);
          const pairs = data.qa.filter((q) => q.table_id === table.id && q.annotate_flag === 1 && (isAdmin || q.annotator_id === userId));
          const cellsDone = cells.filter((c) => (c.target_text ?? "").trim()).length;
          const qaDone = pairs.filter(
            (q) => (q.question_id ?? "").trim() && (q.answer_id ?? "").trim(),
          ).length;
          return (
            <Link
              key={table.id}
              to="/terjemahan/$tableId"
              params={{ tableId: table.id }}
              className="grid grid-cols-[7rem_1fr_8rem_8rem] items-center gap-3 border-b border-line/50 px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-ink/5"
            >
              <span className="font-mono text-xs text-cyan">{table.code}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{table.title_en}</span>
                <span className="block truncate font-mono text-[11px] text-mist">
                  {table.title_id || "judul belum diterjemahkan"}
                </span>
              </span>
              <span className="font-mono text-xs">
                {table.annotate_flag === 1 && (isAdmin || table.annotator_id === userId) ? `${cellsDone}/${cells.length}` : "Tidak ditugaskan"}
              </span>
              <span className="font-mono text-xs">
                {qaDone}/{pairs.length}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
