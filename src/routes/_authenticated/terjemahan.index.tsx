import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
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

const PAGE_SIZE = 30;

function WorkspaceListPage() {
  const { userId, isAdmin, isAnotator, isValidator, rolesLoading, rolesError } = useCurrentUser();
  const allowed = isAdmin || isAnotator || isValidator;
  const [batchFilter, setBatchFilter] = useState("");
  const [pilotMode, setPilotMode] = useState<PilotMode>("all");
  const [page, setPage] = useState(0);

  const batches = useQuery({
    queryKey: ["daftar-tabel", "batch-v10", userId],
    enabled: allowed,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("translation_workspace_batches_v10");
      if (error) throw error;
      return (data ?? []).map((row) => row.batch_no);
    },
  });

  const { data, isPending, isFetching, error } = useQuery({
    queryKey: ["daftar-tabel", "v10", userId, batchFilter, pilotMode, page],
    enabled: allowed,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("translation_workspace_page_v10", {
        _batch: batchFilter ? Number(batchFilter) : null,
        _pilot_mode: pilotMode,
        _limit: PAGE_SIZE,
        _offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return data ?? [];
    },
  });

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert">Gagal memuat peran.</p>;
  if (!allowed)
    return (
      <p role="alert">Halaman ini hanya untuk pengguna yang dapat bertugas sebagai Anotator.</p>
    );
  if (error) return <p role="alert">Gagal memuat ruang kerja: {error.message}</p>;
  if (isPending || !data) return <span className="label-mono">Memuat daftar tabel…</span>;

  const total = data[0]?.total_count ?? 0;

  return (
    <section>
      <PageHeading
        eyebrow="c · ruang kerja terjemahan"
        title="Pilih tabel dataset"
        right={<div className="font-mono text-[11px] text-mist">{total} tabel ditugaskan</div>}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <select
          value={batchFilter}
          onChange={(event) => {
            setBatchFilter(event.target.value);
            setPage(0);
          }}
          className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line"
          aria-label="Filter batch"
        >
          <option value="">Semua batch</option>
          {(batches.data ?? []).map((batch) => (
            <option key={batch} value={batch}>
              Batch {batch}
            </option>
          ))}
        </select>
        <select
          value={pilotMode}
          onChange={(event) => {
            setPilotMode(event.target.value as PilotMode);
            setPage(0);
          }}
          className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line"
          aria-label="Filter pilot"
        >
          <option value="all">Pilot + non-pilot</option>
          <option value="pilot">Pilot saja</option>
          <option value="nonpilot">Non-pilot saja</option>
        </select>
      </div>

      <div className={`panel overflow-x-auto transition-opacity ${isFetching ? "opacity-60" : ""}`}>
        <div className="grid grid-cols-[15%_8%_8%_minmax(0,1fr)_15%_15%] gap-3 border-b border-line/70 px-4 py-2">
          <span className="label-mono">Kode</span>
          <span className="label-mono">Batch</span>
          <span className="label-mono">Pilot</span>
          <span className="label-mono">Judul sumber</span>
          <span className="label-mono">Header/kolom</span>
          <span className="label-mono">Pasangan QA</span>
        </div>

        {data.map((table) => (
          <Link
            key={table.table_id}
            to="/terjemahan/$tableId"
            params={{ tableId: table.table_id }}
            className="grid grid-cols-[15%_8%_8%_minmax(0,1fr)_15%_15%] items-center gap-3 border-b border-line/50 px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-ink/5"
          >
            <span className="min-w-0 truncate font-mono text-xs text-cyan" title={table.code}>
              {table.code}
            </span>
            <span className="font-mono text-xs">{table.batch_no ?? "—"}</span>
            <span>
              {table.is_pilot ? (
                <span className="rounded-full bg-amber/15 px-2 py-1 font-mono text-[10px] text-amber">
                  Pilot
                </span>
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
              {table.header_assigned
                ? `${table.cells_done}/${table.cells_total}`
                : "Tidak ditugaskan"}
            </span>
            <span className="font-mono text-xs">
              {table.qa_done}/{table.qa_total}
            </span>
          </Link>
        ))}

        {!data.length && (
          <div className="px-4 py-8 text-center text-sm text-mist">
            Tidak ada tabel yang cocok dengan filter batch/pilot ini.
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 font-mono text-xs text-mist">
        <span>
          {total
            ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} dari ${total}`
            : "0 tabel"}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page === 0 || isFetching}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-lg px-3 py-2 ring-1 ring-line disabled:opacity-40"
          >
            ← Sebelumnya
          </button>
          <button
            type="button"
            disabled={(page + 1) * PAGE_SIZE >= total || isFetching}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg px-3 py-2 ring-1 ring-line disabled:opacity-40"
          >
            Berikutnya →
          </button>
        </div>
      </div>
    </section>
  );
}
