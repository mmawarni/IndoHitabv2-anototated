import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
          "Daftar tabel IndoHiTAB yang ditugaskan kepada anotator, termasuk progres, status validasi, filter, dan sorting.",
      },
    ],
  }),
  component: WorkspaceListPage,
});

type PilotMode = "all" | "pilot" | "nonpilot";
type WorkStatus = "all" | "selesai" | "cell_belum" | "belum_selesai";
type ValidationFilter = "all" | "validated" | "not_validated";
type ProgressFilter = "all" | "complete" | "incomplete";
type SortDirection = "asc" | "desc";
type SortKey =
  "code" | "batch" | "pilot" | "title" | "status" | "cells" | "qa" | "body" | "validation";

const statusRank: Record<Exclude<WorkStatus, "all">, number> = {
  belum_selesai: 0,
  cell_belum: 1,
  selesai: 2,
};

const PAGE_SIZE = 25;

const GRID_COLS =
  "grid min-w-[75rem] grid-cols-[12rem_4.5rem_4.5rem_minmax(14rem,1fr)_8rem_7rem_7rem_5.5rem_6rem] items-center gap-3";

const STATUS_TABS: { value: WorkStatus; label: string }[] = [
  { value: "all", label: "Semua" },
  { value: "selesai", label: "Selesai" },
  { value: "cell_belum", label: "Body cell belum" },
  { value: "belum_selesai", label: "Belum selesai" },
];

function ratio(done: number, total: number) {
  return total === 0 ? 1 : done / total;
}

function WorkspaceListPage() {
  const { userId, isAdmin, isAnotator, isValidator, rolesLoading, rolesError } = useCurrentUser();
  const allowed = isAdmin || isAnotator || isValidator;

  const [search, setSearch] = useState("");
  const [batchFilter, setBatchFilter] = useState("");
  const [pilotMode, setPilotMode] = useState<PilotMode>("all");
  const [statusFilter, setStatusFilter] = useState<WorkStatus>("all");
  const [validationFilter, setValidationFilter] = useState<ValidationFilter>("all");
  const [cellProgressFilter, setCellProgressFilter] = useState<ProgressFilter>("all");
  const [qaProgressFilter, setQaProgressFilter] = useState<ProgressFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("batch");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(0);

  // Per-table progress is aggregated in the database (hitab_translation_workspace_v14):
  // selecting every table_cells/qa_pairs row under RLS hits the statement timeout.
  // "Done" follows the dashboard (hitab_dashboard_breakdown_v8). Rows come in pages
  // of 1000 (the PostgREST cap); filtering and sorting stay client-side.
  const { data, isLoading, error } = useQuery({
    queryKey: ["daftar-tabel", "v14", userId],
    enabled: allowed,
    queryFn: async () => {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .rpc("hitab_translation_workspace_v14")
          .range(from, from + 999);
        if (error) throw error;
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) return rows;
      }
    },
  });

  // Tables with Laporan Kendala notes; a flag only, it never changes completion status.
  const kendalaFlags = useQuery({
    queryKey: ["kendala-flags", userId],
    enabled: allowed,
    queryFn: async () => {
      const counts = new Map<string, number>();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from("incident_reports")
          .select("table_id")
          .order("id")
          .range(from, from + 999);
        if (error) throw error;
        for (const row of data ?? []) counts.set(row.table_id, (counts.get(row.table_id) ?? 0) + 1);
        if (!data || data.length < 1000) return counts;
      }
    },
  });

  const batchOptions = useMemo(() => {
    if (!data) return [];
    return Array.from(
      new Set(data.map((t) => t.batch_no).filter((value): value is number => value !== null)),
    ).sort((a, b) => a - b);
  }, [data]);

  const assignedTables = useMemo(() => data ?? [], [data]);

  const tableProgress = useMemo(() => {
    const map = new Map<
      string,
      {
        cellsDone: number;
        cellsTotal: number;
        bodyCellsRemaining: number;
        qaDone: number;
        qaTotal: number;
        titleDone: boolean;
        validated: boolean;
        status: Exclude<WorkStatus, "all">;
      }
    >();

    for (const table of assignedTables) {
      const titleDone = Boolean((table.title_id ?? "").trim());

      let status: Exclude<WorkStatus, "all"> = "belum_selesai";

      // Same as the dashboard's "Tabel selesai": title, at least one cell, every cell
      // filled. QA progress has its own column and filter.
      if (titleDone && table.cells_total > 0 && table.cells_done === table.cells_total) {
        status = "selesai";
      } else if (
        titleDone &&
        table.non_body_cells_remaining === 0 &&
        table.body_cells_remaining > 0
      ) {
        status = "cell_belum";
      }

      map.set(table.id, {
        cellsDone: table.cells_done,
        cellsTotal: table.cells_total,
        bodyCellsRemaining: table.body_cells_remaining,
        qaDone: table.qa_done,
        qaTotal: table.qa_total,
        titleDone,
        validated: table.validated,
        status,
      });
    }

    return map;
  }, [assignedTables]);

  const statusCounts = useMemo(() => {
    const result = {
      selesai: 0,
      cell_belum: 0,
      belum_selesai: 0,
      validated: 0,
    };

    for (const table of assignedTables) {
      const progress = tableProgress.get(table.id);
      if (!progress) continue;
      result[progress.status] += 1;
      if (progress.validated) result.validated += 1;
    }
    return result;
  }, [assignedTables, tableProgress]);

  const visibleTables = useMemo(() => {
    const query = search.trim().toLowerCase();

    const filtered = assignedTables.filter((table) => {
      const progress = tableProgress.get(table.id);
      if (!progress) return false;

      if (query) {
        const haystack = [
          table.code,
          table.title_en,
          table.title_id ?? "",
          table.batch_no?.toString() ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      if (batchFilter && table.batch_no !== Number(batchFilter)) return false;
      if (pilotMode === "pilot" && !table.is_pilot) return false;
      if (pilotMode === "nonpilot" && table.is_pilot) return false;
      if (statusFilter !== "all" && progress.status !== statusFilter) return false;
      if (validationFilter === "validated" && !progress.validated) return false;
      if (validationFilter === "not_validated" && progress.validated) return false;

      const cellsComplete = progress.cellsTotal === 0 || progress.cellsDone === progress.cellsTotal;
      if (cellProgressFilter === "complete" && !cellsComplete) return false;
      if (cellProgressFilter === "incomplete" && cellsComplete) return false;

      const qaComplete = progress.qaTotal === 0 || progress.qaDone === progress.qaTotal;
      if (qaProgressFilter === "complete" && !qaComplete) return false;
      if (qaProgressFilter === "incomplete" && qaComplete) return false;

      return true;
    });

    const direction = sortDirection === "asc" ? 1 : -1;

    return [...filtered].sort((a, b) => {
      const pa = tableProgress.get(a.id)!;
      const pb = tableProgress.get(b.id)!;
      let result = 0;

      switch (sortKey) {
        case "code":
          result = (a.code ?? "").localeCompare(b.code ?? "", "id", {
            numeric: true,
            sensitivity: "base",
          });
          break;
        case "batch":
          result =
            (a.batch_no ?? Number.MAX_SAFE_INTEGER) - (b.batch_no ?? Number.MAX_SAFE_INTEGER);
          break;
        case "pilot":
          result = Number(Boolean(a.is_pilot)) - Number(Boolean(b.is_pilot));
          break;
        case "title":
          result = (a.title_en ?? "").localeCompare(b.title_en ?? "", "id", {
            numeric: true,
            sensitivity: "base",
          });
          break;
        case "status":
          result = statusRank[pa.status] - statusRank[pb.status];
          break;
        case "cells": {
          const ratioDiff = ratio(pa.cellsDone, pa.cellsTotal) - ratio(pb.cellsDone, pb.cellsTotal);
          result =
            ratioDiff !== 0
              ? ratioDiff
              : pa.cellsDone - pb.cellsDone || pa.cellsTotal - pb.cellsTotal;
          break;
        }
        case "qa": {
          const ratioDiff = ratio(pa.qaDone, pa.qaTotal) - ratio(pb.qaDone, pb.qaTotal);
          result = ratioDiff !== 0 ? ratioDiff : pa.qaDone - pb.qaDone || pa.qaTotal - pb.qaTotal;
          break;
        }
        case "body":
          result = pa.bodyCellsRemaining - pb.bodyCellsRemaining;
          break;
        case "validation":
          result = Number(pa.validated) - Number(pb.validated);
          break;
      }

      if (result === 0) {
        result = (a.code ?? "").localeCompare(b.code ?? "", "id", {
          numeric: true,
          sensitivity: "base",
        });
      }
      return result * direction;
    });
  }, [
    assignedTables,
    tableProgress,
    search,
    batchFilter,
    pilotMode,
    statusFilter,
    validationFilter,
    cellProgressFilter,
    qaProgressFilter,
    sortKey,
    sortDirection,
  ]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  };

  const sortArrow = (key: SortKey) => {
    if (sortKey !== key) return "↕";
    return sortDirection === "asc" ? "↑" : "↓";
  };

  // Any change to the result set sends the user back to the first page.
  useEffect(() => {
    setPage(0);
  }, [
    search,
    batchFilter,
    pilotMode,
    statusFilter,
    validationFilter,
    cellProgressFilter,
    qaProgressFilter,
    sortKey,
    sortDirection,
  ]);

  const pageCount = Math.max(1, Math.ceil(visibleTables.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageTables = visibleTables.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const extraFilterCount = [
    batchFilter !== "",
    pilotMode !== "all",
    validationFilter !== "all",
    cellProgressFilter !== "all",
    qaProgressFilter !== "all",
  ].filter(Boolean).length;
  const anyFilterActive = extraFilterCount > 0 || search.trim() !== "" || statusFilter !== "all";

  const resetFilters = () => {
    setSearch("");
    setBatchFilter("");
    setPilotMode("all");
    setStatusFilter("all");
    setValidationFilter("all");
    setCellProgressFilter("all");
    setQaProgressFilter("all");
  };

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert">Gagal memuat peran.</p>;
  if (!allowed) {
    return (
      <p role="alert">Halaman ini hanya untuk pengguna yang dapat bertugas sebagai Anotator.</p>
    );
  }
  if (isLoading || !data) {
    return <span className="label-mono">Memuat daftar tabel…</span>;
  }
  if (error) {
    return <p role="alert">Gagal memuat ruang kerja: {error.message}</p>;
  }

  const headerButtonClass = "flex w-full items-center gap-1 text-left label-mono hover:text-ink";
  const selectClass =
    "rounded-md bg-transparent px-2 py-1.5 text-sm ring-1 ring-line focus:outline-none focus:ring-ink/30";
  const statusCount = (value: WorkStatus) =>
    value === "all" ? assignedTables.length : statusCounts[value];
  const sortHeader = (key: SortKey, label: string) => (
    <button type="button" className={headerButtonClass} onClick={() => toggleSort(key)}>
      <span>{label}</span>
      <span className={sortKey === key ? "text-ink" : "text-mist/50"}>{sortArrow(key)}</span>
    </button>
  );
  const percent = (done: number, total: number) => Math.round(ratio(done, total) * 100);

  return (
    <section>
      <PageHeading
        eyebrow="c · ruang kerja terjemahan"
        title="Pilih tabel dataset"
        right={
          <div className="font-mono text-[11px] text-mist">
            {visibleTables.length} / {assignedTables.length} tabel · {statusCounts.validated}{" "}
            divalidasi
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cari kode / judul…"
          className="min-w-[14rem] flex-1 rounded-md bg-transparent px-3 py-1.5 text-sm ring-1 ring-line focus:outline-none focus:ring-ink/30"
          aria-label="Cari tabel"
        />
        <button
          type="button"
          onClick={() => setShowFilters((open) => !open)}
          aria-expanded={showFilters}
          className={`rounded-md px-3 py-1.5 text-sm ring-1 ring-line hover:bg-ink/5 ${showFilters ? "bg-ink/5" : ""}`}
        >
          Filter
          {extraFilterCount > 0 && (
            <span className="ml-1 font-mono text-xs text-cyan">{extraFilterCount}</span>
          )}
        </button>
        {anyFilterActive && (
          <button
            type="button"
            onClick={resetFilters}
            className="px-2 py-1.5 text-sm text-mist hover:text-ink"
          >
            Reset
          </button>
        )}
      </div>

      {showFilters && (
        <div className="mb-3 flex flex-wrap gap-2">
          <select
            value={batchFilter}
            onChange={(event) => setBatchFilter(event.target.value)}
            className={selectClass}
            aria-label="Filter batch"
          >
            <option value="">Semua batch</option>
            {batchOptions.map((batch) => (
              <option key={batch} value={batch}>
                Batch {batch}
              </option>
            ))}
          </select>
          <select
            value={pilotMode}
            onChange={(event) => setPilotMode(event.target.value as PilotMode)}
            className={selectClass}
            aria-label="Filter pilot"
          >
            <option value="all">Pilot + non-pilot</option>
            <option value="pilot">Pilot saja</option>
            <option value="nonpilot">Non-pilot saja</option>
          </select>
          <select
            value={validationFilter}
            onChange={(event) => setValidationFilter(event.target.value as ValidationFilter)}
            className={selectClass}
            aria-label="Filter validasi"
          >
            <option value="all">Semua validasi</option>
            <option value="validated">Sudah divalidasi ({statusCounts.validated})</option>
            <option value="not_validated">Belum divalidasi</option>
          </select>
          <select
            value={cellProgressFilter}
            onChange={(event) => setCellProgressFilter(event.target.value as ProgressFilter)}
            className={selectClass}
            aria-label="Filter progres header kolom"
          >
            <option value="all">Semua Header/kolom</option>
            <option value="complete">Header/kolom lengkap</option>
            <option value="incomplete">Header/kolom belum lengkap</option>
          </select>
          <select
            value={qaProgressFilter}
            onChange={(event) => setQaProgressFilter(event.target.value as ProgressFilter)}
            className={selectClass}
            aria-label="Filter progres QA"
          >
            <option value="all">Semua QA</option>
            <option value="complete">QA lengkap</option>
            <option value="incomplete">QA belum lengkap</option>
          </select>
        </div>
      )}

      <div
        role="tablist"
        aria-label="Filter status penyelesaian"
        className="mb-3 flex flex-wrap gap-1 border-b border-line/70"
      >
        {STATUS_TABS.map((tab) => {
          const active = statusFilter === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setStatusFilter(tab.value)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${active ? "border-ink text-ink" : "border-transparent text-mist hover:text-ink"}`}
            >
              {tab.label}
              <span className="ml-1.5 font-mono text-xs text-mist">{statusCount(tab.value)}</span>
            </button>
          );
        })}
      </div>

      <div className="panel overflow-x-auto">
        <div
          className={`${GRID_COLS} border-b border-line/70 py-2 pr-4`}
          title="Header/kolom dan Pasangan QA diurutkan berdasarkan persentase progres, lalu jumlah selesai."
        >
          <div className="sticky left-0 z-10 bg-frost py-1 pl-4">{sortHeader("code", "Kode")}</div>
          {sortHeader("batch", "Batch")}
          {sortHeader("pilot", "Pilot")}
          {sortHeader("title", "Judul sumber")}
          {sortHeader("status", "Status")}
          {sortHeader("cells", "Header/kolom")}
          {sortHeader("qa", "QA")}
          {sortHeader("body", "Body sisa")}
          {sortHeader("validation", "Validasi")}
        </div>

        {pageTables.map((table) => {
          const progress = tableProgress.get(table.id);
          if (!progress) return null;

          return (
            <Link
              key={table.id}
              to="/terjemahan/$tableId"
              params={{ tableId: table.id }}
              className={`${GRID_COLS} group border-b border-line/40 py-2.5 pr-4 text-sm transition-colors last:border-b-0 hover:bg-ink/5`}
            >
              <span
                className="sticky left-0 z-10 flex min-w-0 items-center gap-1.5 bg-frost py-1 pl-4 font-mono text-xs text-cyan"
                title={table.code}
              >
                <span className="truncate group-hover:underline">{table.code}</span>
                {!!kendalaFlags.data?.get(table.id) && (
                  <span
                    className="shrink-0 rounded-full bg-amber/15 px-1.5 py-0.5 text-[10px] text-amber"
                    title={`${kendalaFlags.data.get(table.id)} catatan Laporan Kendala`}
                  >
                    ⚑ {kendalaFlags.data.get(table.id)}
                  </span>
                )}
              </span>
              <span className="font-mono text-xs text-mist">{table.batch_no ?? "—"}</span>
              <span className="font-mono text-xs">
                {table.is_pilot ? (
                  <span className="text-amber">Pilot</span>
                ) : (
                  <span className="text-mist">—</span>
                )}
              </span>
              <span className="min-w-0">
                <span className="block truncate">{table.title_en}</span>
                <span className="block truncate text-xs text-mist">
                  {table.title_id || "judul belum diterjemahkan"}
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-xs">
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full ${progress.status === "selesai" ? "bg-teal" : progress.status === "cell_belum" ? "bg-amber" : "bg-mist/50"}`}
                />
                {progress.status === "selesai"
                  ? "Selesai"
                  : progress.status === "cell_belum"
                    ? "Cell belum"
                    : "Belum selesai"}
              </span>
              <span className="font-mono text-xs">
                {progress.cellsDone}/{progress.cellsTotal}
                <span className="ml-1 text-mist">
                  {percent(progress.cellsDone, progress.cellsTotal)}%
                </span>
              </span>
              <span className="font-mono text-xs">
                {progress.qaDone}/{progress.qaTotal}
                <span className="ml-1 text-mist">
                  {percent(progress.qaDone, progress.qaTotal)}%
                </span>
              </span>
              <span
                className={`font-mono text-xs ${progress.bodyCellsRemaining > 0 ? "text-amber" : "text-mist"}`}
              >
                {progress.bodyCellsRemaining}
              </span>
              <span className="text-xs">
                {progress.validated ? (
                  <span className="text-cyan">✓ Divalidasi</span>
                ) : (
                  <span className="text-mist">—</span>
                )}
              </span>
            </Link>
          );
        })}

        {!visibleTables.length && (
          <div className="px-4 py-8 text-center text-sm text-mist">
            Tidak ada tabel yang cocok dengan filter saat ini.
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 font-mono text-xs text-mist">
        <span>
          {visibleTables.length
            ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, visibleTables.length)} dari ${visibleTables.length}`
            : "0 tabel"}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
            className="rounded-md px-3 py-1.5 ring-1 ring-line hover:bg-ink/5 disabled:opacity-40"
          >
            ← Sebelumnya
          </button>
          <span>
            {currentPage + 1} / {pageCount}
          </span>
          <button
            type="button"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
            className="rounded-md px-3 py-1.5 ring-1 ring-line hover:bg-ink/5 disabled:opacity-40"
          >
            Berikutnya →
          </button>
        </div>
      </div>
    </section>
  );
}
