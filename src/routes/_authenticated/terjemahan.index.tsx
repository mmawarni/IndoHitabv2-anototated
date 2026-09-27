import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeading } from "@/components/AppShell";
import { useCurrentUser } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/terjemahan/")({
  head: () => ({
    meta: [
      { title: "Ruang Kerja Terjemahan — IndoHiTAB" },
      {
        name: "description",
        content:
          "Daftar tabel IndoHiTAB yang ditugaskan kepada anotator, termasuk informasi batch dan pilot.",
      },
    ],
  }),
  component: WorkspaceListPage,
});

type PilotMode = "all" | "pilot" | "nonpilot";

const FETCH_PAGE = 1000;

async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += FETCH_PAGE) {
    const { data, error } = await page(from, from + FETCH_PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < FETCH_PAGE) return rows;
  }
}

function WorkspaceListPage() {
  const { userId, isAdmin, isAnotator, isValidator, rolesLoading, rolesError } = useCurrentUser();
  const allowed = isAdmin || isAnotator || isValidator;
  const [batchFilter, setBatchFilter] = useState("");
  const [pilotMode, setPilotMode] = useState<PilotMode>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["daftar-tabel-v10", userId, isAdmin],
    enabled: allowed,
    queryFn: async () => {
      // Supabase caps each request at 1000 rows, so every list is fetched page by page.
      const [tables, qa] = await Promise.all([
        fetchAll((from, to) =>
          supabase
            .from("tqa_tables")
            .select("id, code, title_en, title_id, annotate_flag, annotator_id, batch_no, is_pilot")
            .order("batch_no", { ascending: true, nullsFirst: false })
            .order("code")
            .order("id")
            .range(from, to),
        ),
        fetchAll((from, to) => {
          let query = supabase
            .from("qa_pairs")
            .select("id, table_id, question_id, answer_id, annotate_flag, annotator_id")
            .eq("annotate_flag", 1);
          if (!isAdmin) query = query.eq("annotator_id", userId!);
          return query.order("id").range(from, to);
        }),
      ]);

      // Cell progress is only shown for tables assigned for header translation.
      const cellTableIds = tables
        .filter((t) => t.annotate_flag === 1 && (isAdmin || t.annotator_id === userId))
        .map((t) => t.id);
      const cells = [];
      for (let i = 0; i < cellTableIds.length; i += 100) {
        const ids = cellTableIds.slice(i, i + 100);
        cells.push(
          ...(await fetchAll((from, to) =>
            supabase
              .from("table_cells")
              .select("id, table_id, target_text")
              .in("table_id", ids)
              .order("id")
              .range(from, to),
          )),
        );
      }
      return { tables, cells, qa };
    },
  });

  const batchOptions = useMemo(() => {
    if (!data) return [];
    return Array.from(
      new Set(
        data.tables
          .map((t) => t.batch_no)
          .filter((value): value is number => value !== null),
      ),
    ).sort((a, b) => a - b);
  }, [data]);

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert">Gagal memuat peran.</p>;
  if (!allowed) return <p role="alert">Halaman ini hanya untuk pengguna yang dapat bertugas sebagai Anotator.</p>;
  if (isLoading || !data) return <span className="label-mono">Memuat daftar tabel…</span>;
  if (error) return <p role="alert">Gagal memuat ruang kerja: {error.message}</p>;

  const assignedTables = data.tables.filter((t) => {
    const tableAssigned = isAdmin || (t.annotate_flag === 1 && t.annotator_id === userId);
    const qaAssigned = data.qa.some(
      (q) => q.table_id === t.id && q.annotate_flag === 1 && (isAdmin || q.annotator_id === userId),
    );
    return tableAssigned || qaAssigned;
  });

  const visibleTables = assignedTables.filter((table) => {
    if (batchFilter && table.batch_no !== Number(batchFilter)) return false;
    if (pilotMode === "pilot" && !table.is_pilot) return false;
    if (pilotMode === "nonpilot" && table.is_pilot) return false;
    return true;
  });

  return (
    <section>
      <PageHeading
        eyebrow="c · ruang kerja terjemahan"
        title="Pilih tabel dataset"
        right={
          <div className="font-mono text-[11px] text-mist">
            {visibleTables.length} / {assignedTables.length} tabel ditampilkan
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <select
          value={batchFilter}
          onChange={(event) => setBatchFilter(event.target.value)}
          className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line"
          aria-label="Filter batch"
        >
          <option value="">Semua batch</option>
          {batchOptions.map((batch) => (
            <option key={batch} value={batch}>Batch {batch}</option>
          ))}
        </select>
        <select
          value={pilotMode}
          onChange={(event) => setPilotMode(event.target.value as PilotMode)}
          className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line"
          aria-label="Filter pilot"
        >
          <option value="all">Pilot + non-pilot</option>
          <option value="pilot">Pilot saja</option>
          <option value="nonpilot">Non-pilot saja</option>
        </select>
      </div>

      <div className="panel overflow-x-auto">
        <div className="grid grid-cols-[15%_8%_8%_minmax(0,1fr)_15%_15%] gap-3 border-b border-line/70 px-4 py-2">
          <span className="label-mono">Kode</span>
          <span className="label-mono">Batch</span>
          <span className="label-mono">Pilot</span>
          <span className="label-mono">Judul sumber</span>
          <span className="label-mono">Header/kolom</span>
          <span className="label-mono">Pasangan QA</span>
        </div>

        {visibleTables.map((table) => {
          const cells = data.cells.filter((c) => c.table_id === table.id);
          const pairs = data.qa.filter(
            (q) => q.table_id === table.id && q.annotate_flag === 1 && (isAdmin || q.annotator_id === userId),
          );
          const cellsDone = cells.filter((c) => (c.target_text ?? "").trim()).length;
          const qaDone = pairs.filter(
            (q) => (q.question_id ?? "").trim() && (q.answer_id ?? "").trim(),
          ).length;
          return (
            <Link
              key={table.id}
              to="/terjemahan/$tableId"
              params={{ tableId: table.id }}
              className="grid grid-cols-[15%_8%_8%_minmax(0,1fr)_15%_15%] items-center gap-3 border-b border-line/50 px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-ink/5"
            >
              <span className="min-w-0 truncate font-mono text-xs text-cyan" title={table.code}>{table.code}</span>
              <span className="font-mono text-xs">{table.batch_no ?? "—"}</span>
              <span>
                {table.is_pilot ? (
                  <span className="rounded-full bg-amber/15 px-2 py-1 font-mono text-[10px] text-amber">Pilot</span>
                ) : (
                  <span className="text-xs text-mist">—</span>
                )}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{table.title_en}</span>
                <span className="block truncate font-mono text-[11px] text-mist">
                  {table.title_id || "judul belum diterjemahkan"}
                </span>
              </span>
              <span className="font-mono text-xs">
                {table.annotate_flag === 1 && (isAdmin || table.annotator_id === userId)
                  ? `${cellsDone}/${cells.length}`
                  : "Tidak ditugaskan"}
              </span>
              <span className="font-mono text-xs">{qaDone}/{pairs.length}</span>
            </Link>
          );
        })}

        {!visibleTables.length && (
          <div className="px-4 py-8 text-center text-sm text-mist">
            Tidak ada tabel yang cocok dengan filter batch/pilot ini.
          </div>
        )}
      </div>
    </section>
  );
}
