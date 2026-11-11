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
  | "code"
  | "batch"
  | "pilot"
  | "title"
  | "status"
  | "cells"
  | "qa"
  | "body"
  | "validation";

const statusRank: Record<Exclude<WorkStatus, "all">, number> = {
  belum_selesai: 0,
  cell_belum: 1,
  selesai: 2,
};

function ratio(done: number, total: number) {
  return total === 0 ? 1 : done / total;
}

function WorkspaceListPage() {
  const { userId, isAdmin, isAnotator, isValidator, rolesLoading, rolesError } =
    useCurrentUser();
  const allowed = isAdmin || isAnotator || isValidator;

  const [search, setSearch] = useState("");
  const [batchFilter, setBatchFilter] = useState("");
  const [pilotMode, setPilotMode] = useState<PilotMode>("all");
  const [statusFilter, setStatusFilter] = useState<WorkStatus>("all");
  const [validationFilter, setValidationFilter] =
    useState<ValidationFilter>("all");
  const [cellProgressFilter, setCellProgressFilter] =
    useState<ProgressFilter>("all");
  const [qaProgressFilter, setQaProgressFilter] =
    useState<ProgressFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("batch");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const { data, isLoading, error } = useQuery({
    queryKey: ["daftar-tabel-v11-sort-validation", userId],
    enabled: allowed,
    queryFn: async () => {
      const [tables, cells, qa] = await Promise.all([
        supabase
          .from("tqa_tables")
          .select(
            "id, code, title_en, title_id, annotate_flag, annotator_id, batch_no, is_pilot, validated_table",
          )
          .order("batch_no", { ascending: true, nullsFirst: false })
          .order("code"),
        supabase
          .from("table_cells")
          .select("id, table_id, target_text, is_body_text"),
        supabase
          .from("qa_pairs")
          .select(
            "id, table_id, question_id, answer_id, validated_qa, annotate_flag, annotator_id",
          ),
      ]);

      if (tables.error) throw tables.error;
      if (cells.error) throw cells.error;
      if (qa.error) throw qa.error;

      return {
        tables: tables.data ?? [],
        cells: cells.data ?? [],
        qa: qa.data ?? [],
      };
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

  const qaByTable = useMemo(() => {
    const map = new Map<string, NonNullable<typeof data>["qa"]>();
    if (!data) return map;

    for (const pair of data.qa) {
      if (pair.annotate_flag !== 1) continue;
      const current = map.get(pair.table_id) ?? [];
      current.push(pair);
      map.set(pair.table_id, current);
    }
    return map;
  }, [data]);

  const cellsByTable = useMemo(() => {
    const map = new Map<string, NonNullable<typeof data>["cells"]>();
    if (!data) return map;

    for (const cell of data.cells) {
      const current = map.get(cell.table_id) ?? [];
      current.push(cell);
      map.set(cell.table_id, current);
    }
    return map;
  }, [data]);

  const assignedTables = useMemo(() => {
    if (!data) return [];

    return data.tables.filter((table) => {
      if (table.annotate_flag !== 1) return false;
      if (isAdmin) return true;
      if (table.annotator_id === userId) return true;

      return (qaByTable.get(table.id) ?? []).some(
        (q) => q.annotator_id === userId,
      );
    });
  }, [data, isAdmin, userId, qaByTable]);

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
      const cells = cellsByTable.get(table.id) ?? [];
      const pairs = qaByTable.get(table.id) ?? [];
      const titleDone = Boolean((table.title_id ?? "").trim());

      const cellsDone = cells.filter((cell) =>
        Boolean((cell.target_text ?? "").trim()),
      ).length;

      const bodyCellsRemaining = cells.filter(
        (cell) =>
          cell.is_body_text === true && !(cell.target_text ?? "").trim(),
      ).length;

      const nonBodyCellsComplete = cells
        .filter((cell) => cell.is_body_text !== true)
        .every((cell) => Boolean((cell.target_text ?? "").trim()));

      const qaDone = pairs.filter(
        (q) =>
          Boolean((q.question_id ?? "").trim()) &&
          Boolean((q.answer_id ?? "").trim()),
      ).length;

      const qaComplete = pairs.length === 0 || qaDone === pairs.length;
      const allCellsComplete = cells.length === 0 || cellsDone === cells.length;

      let status: Exclude<WorkStatus, "all"> = "belum_selesai";

      if (titleDone && allCellsComplete && qaComplete) {
        status = "selesai";
      } else if (
        titleDone &&
        nonBodyCellsComplete &&
        qaComplete &&
        bodyCellsRemaining > 0
      ) {
        status = "cell_belum";
      }

      map.set(table.id, {
        cellsDone,
        cellsTotal: cells.length,
        bodyCellsRemaining,
        qaDone,
        qaTotal: pairs.length,
        titleDone,
        validated: table.validated_table !== null,
        status,
      });
    }

    return map;
  }, [assignedTables, cellsByTable, qaByTable]);

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

      const cellsComplete =
        progress.cellsTotal === 0 || progress.cellsDone === progress.cellsTotal;
      if (cellProgressFilter === "complete" && !cellsComplete) return false;
      if (cellProgressFilter === "incomplete" && cellsComplete) return false;

      const qaComplete =
        progress.qaTotal === 0 || progress.qaDone === progress.qaTotal;
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
            (a.batch_no ?? Number.MAX_SAFE_INTEGER) -
            (b.batch_no ?? Number.MAX_SAFE_INTEGER);
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
          const ratioDiff =
            ratio(pa.cellsDone, pa.cellsTotal) -
            ratio(pb.cellsDone, pb.cellsTotal);
          result =
            ratioDiff !== 0
              ? ratioDiff
              : pa.cellsDone - pb.cellsDone || pa.cellsTotal - pb.cellsTotal;
          break;
        }
        case "qa": {
          const ratioDiff =
            ratio(pa.qaDone, pa.qaTotal) - ratio(pb.qaDone, pb.qaTotal);
          result =
            ratioDiff !== 0
              ? ratioDiff
              : pa.qaDone - pb.qaDone || pa.qaTotal - pb.qaTotal;
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
      <p role="alert">
        Halaman ini hanya untuk pengguna yang dapat bertugas sebagai Anotator.
      </p>
    );
  }
  if (isLoading || !data) {
    return <span className="label-mono">Memuat daftar tabel…</span>;
  }
  if (error) {
    return <p role="alert">Gagal memuat ruang kerja: {error.message}</p>;
  }

  const headerButtonClass =
    "flex w-full items-center justify-between gap-1 text-left label-mono hover:text-ink";

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

      <div className="mb-4 grid gap-2 lg:grid-cols-4">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cari kode / judul…"
          className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line"
          aria-label="Cari tabel"
        />

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

        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as WorkStatus)}
          className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line"
          aria-label="Filter status penyelesaian"
        >
          <option value="all">Semua status terjemahan</option>
          <option value="selesai">Selesai ({statusCounts.selesai})</option>
          <option value="cell_belum">
            Terjemahan lama selesai, body cell belum ({statusCounts.cell_belum})
          </option>
          <option value="belum_selesai">
            Belum selesai ({statusCounts.belum_selesai})
          </option>
        </select>

        <select
          value={validationFilter}
          onChange={(event) =>
            setValidationFilter(event.target.value as ValidationFilter)
          }
          className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line"
          aria-label="Filter validasi"
        >
          <option value="all">Semua status validasi</option>
          <option value="validated">Sudah divalidasi ({statusCounts.validated})</option>
          <option value="not_validated">Belum divalidasi</option>
        </select>

        <select
          value={cellProgressFilter}
          onChange={(event) =>
            setCellProgressFilter(event.target.value as ProgressFilter)
          }
          className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line"
          aria-label="Filter progres header kolom"
        >
          <option value="all">Semua progres Header/kolom</option>
          <option value="complete">Header/kolom lengkap</option>
          <option value="incomplete">Header/kolom belum lengkap</option>
        </select>

        <select
          value={qaProgressFilter}
          onChange={(event) =>
            setQaProgressFilter(event.target.value as ProgressFilter)
          }
          className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line"
          aria-label="Filter progres QA"
        >
          <option value="all">Semua progres QA</option>
          <option value="complete">QA lengkap</option>
          <option value="incomplete">QA belum lengkap</option>
        </select>

        <button
          type="button"
          onClick={resetFilters}
          className="rounded-lg px-3 py-2 text-sm ring-1 ring-line hover:bg-ink/5"
        >
          Reset filter
        </button>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-4">
        <div className="rounded-lg bg-teal/10 px-3 py-2 ring-1 ring-teal/20">
          <div className="font-mono text-[10px] uppercase text-mist">Selesai</div>
          <div className="mt-1 text-lg font-semibold">{statusCounts.selesai}</div>
        </div>
        <div className="rounded-lg bg-amber/10 px-3 py-2 ring-1 ring-amber/20">
          <div className="font-mono text-[10px] uppercase text-mist">
            Terjemahan ada, body cell belum
          </div>
          <div className="mt-1 text-lg font-semibold">{statusCounts.cell_belum}</div>
        </div>
        <div className="rounded-lg bg-ink/5 px-3 py-2 ring-1 ring-line">
          <div className="font-mono text-[10px] uppercase text-mist">Belum selesai</div>
          <div className="mt-1 text-lg font-semibold">{statusCounts.belum_selesai}</div>
        </div>
        <div className="rounded-lg bg-cyan/10 px-3 py-2 ring-1 ring-cyan/20">
          <div className="font-mono text-[10px] uppercase text-mist">Sudah divalidasi</div>
          <div className="mt-1 text-lg font-semibold">{statusCounts.validated}</div>
        </div>
      </div>

      <p className="mb-3 text-xs text-mist">
        Klik judul kolom untuk sorting. Header/kolom dan Pasangan QA diurutkan
        berdasarkan persentase progres, lalu jumlah selesai sebagai tie-breaker.
      </p>

      <div className="panel overflow-x-auto">
        <div className="grid min-w-[1260px] grid-cols-[7rem_5rem_5rem_1fr_9rem_8rem_8rem_9rem_9rem] gap-3 border-b border-line/70 px-4 py-2">
          <button className={headerButtonClass} onClick={() => toggleSort("code")}><span>Kode</span><span>{sortArrow("code")}</span></button>
          <button className={headerButtonClass} onClick={() => toggleSort("batch")}><span>Batch</span><span>{sortArrow("batch")}</span></button>
          <button className={headerButtonClass} onClick={() => toggleSort("pilot")}><span>Pilot</span><span>{sortArrow("pilot")}</span></button>
          <button className={headerButtonClass} onClick={() => toggleSort("title")}><span>Judul sumber</span><span>{sortArrow("title")}</span></button>
          <button className={headerButtonClass} onClick={() => toggleSort("status")}><span>Status</span><span>{sortArrow("status")}</span></button>
          <button className={headerButtonClass} onClick={() => toggleSort("cells")}><span>Header/kolom</span><span>{sortArrow("cells")}</span></button>
          <button className={headerButtonClass} onClick={() => toggleSort("qa")}><span>Pasangan QA</span><span>{sortArrow("qa")}</span></button>
          <button className={headerButtonClass} onClick={() => toggleSort("body")}><span>Body tersisa</span><span>{sortArrow("body")}</span></button>
          <button className={headerButtonClass} onClick={() => toggleSort("validation")}><span>Validasi</span><span>{sortArrow("validation")}</span></button>
        </div>

        {visibleTables.map((table) => {
          const progress = tableProgress.get(table.id);
          if (!progress) return null;

          return (
            <Link
              key={table.id}
              to="/terjemahan/$tableId"
              params={{ tableId: table.id }}
              className="grid min-w-[1260px] grid-cols-[7rem_5rem_5rem_1fr_9rem_8rem_8rem_9rem_9rem] items-center gap-3 border-b border-line/50 px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-ink/5"
            >
              <span className="font-mono text-xs text-cyan">{table.code}</span>
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
              <span>
                {progress.status === "selesai" ? (
                  <span className="rounded-full bg-teal/10 px-2 py-1 font-mono text-[10px] text-teal ring-1 ring-teal/20">Selesai</span>
                ) : progress.status === "cell_belum" ? (
                  <span className="rounded-full bg-amber/10 px-2 py-1 font-mono text-[10px] text-amber ring-1 ring-amber/20">Cell belum</span>
                ) : (
                  <span className="rounded-full px-2 py-1 font-mono text-[10px] text-mist ring-1 ring-line">Belum selesai</span>
                )}
              </span>
              <span className="font-mono text-xs">
                {progress.cellsDone}/{progress.cellsTotal}
                <span className="ml-1 text-[10px] text-mist">
                  ({Math.round(ratio(progress.cellsDone, progress.cellsTotal) * 100)}%)
                </span>
              </span>
              <span className="font-mono text-xs">
                {progress.qaDone}/{progress.qaTotal}
                <span className="ml-1 text-[10px] text-mist">
                  ({Math.round(ratio(progress.qaDone, progress.qaTotal) * 100)}%)
                </span>
              </span>
              <span className={progress.bodyCellsRemaining > 0 ? "font-mono text-xs text-amber" : "font-mono text-xs text-mist"}>
                {progress.bodyCellsRemaining}
              </span>
              <span>
                {progress.validated ? (
                  <span className="rounded-full bg-cyan/10 px-2 py-1 font-mono text-[10px] text-cyan ring-1 ring-cyan/20">✓ Divalidasi</span>
                ) : (
                  <span className="rounded-full px-2 py-1 font-mono text-[10px] text-mist ring-1 ring-line">Belum</span>
                )}
              </span>
            </Link>
          );
        })}

        {!visibleTables.length && (
          <div className="min-w-[1260px] px-4 py-8 text-center text-sm text-mist">
            Tidak ada tabel yang cocok dengan filter saat ini.
          </div>
        )}
      </div>
    </section>
  );
}
