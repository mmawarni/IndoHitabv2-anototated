import { createFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeading } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/penugasan")({
  head: () => ({ meta: [{ title: "Penugasan — IndoHiTAB" }] }),
  component: AssignmentPage,
});

type PilotMode = "all" | "pilot" | "nonpilot";
type UserOption = { id: string; full_name: string; email: string; roles: string[] };
type QueueRow = {
  item_id: string;
  source_id: string | null;
  table_code: string;
  source_text: string;
  annotate_flag: number;
  annotator_id: string | null;
  validator_id: string | null;
  batch_no: number | null;
  is_pilot: boolean;
  qa_count: number;
  total_count: number;
};
type BatchSummary = {
  batch_no: number;
  tables: number;
  qa: number;
  pilot_tables: number;
  pilot_qa: number;
  assigned_tables: number;
};
type AssignmentResult = {
  batch?: number;
  pilot_mode?: PilotMode;
  tables_assigned: number;
  qa_assigned: number;
  qa_excluded_by_sampling: number;
};

const PAGE_SIZE = 30;
const KEEP = "__keep__";
const NONE = "__none__";

function AssignmentPage() {
  const { isAdmin, rolesLoading, rolesError } = useCurrentUser();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [batchFilter, setBatchFilter] = useState<string>("");
  const [pilotMode, setPilotMode] = useState<PilotMode>("all");
  const [page, setPage] = useState(0);

  const [batchToAssign, setBatchToAssign] = useState<string>("");
  const [batchPilotMode, setBatchPilotMode] = useState<PilotMode>("all");
  const [batchAnnotator, setBatchAnnotator] = useState(KEEP);
  const [batchValidator, setBatchValidator] = useState(KEEP);

  useEffect(() => setPage(0), [deferredSearch, batchFilter, pilotMode]);

  const users = useQuery({
    queryKey: ["assignment-users"],
    enabled: isAdmin,
    queryFn: async () => {
      const [profiles, roles] = await Promise.all([
        supabase.from("profiles").select("id,full_name,email,status").eq("status", "aktif").order("full_name"),
        supabase.from("user_roles").select("user_id,role"),
      ]);
      if (profiles.error) throw profiles.error;
      if (roles.error) throw roles.error;
      const roleMap = new Map<string, string[]>();
      for (const r of roles.data ?? []) roleMap.set(r.user_id, [...(roleMap.get(r.user_id) ?? []), r.role]);
      return (profiles.data ?? []).map((profile) => ({
        id: profile.id,
        full_name: profile.full_name,
        email: profile.email,
        roles: roleMap.get(profile.id) ?? [],
      }));
    },
  });

  const batchSummary = useQuery({
    queryKey: ["assignment-batch-summary-v9"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("assignment_batch_summary_v9");
      if (error) throw error;
      return (data ?? []) as BatchSummary[];
    },
  });

  const queue = useQuery({
    queryKey: ["table-assignment-queue-v9", deferredSearch, batchFilter, pilotMode, page],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("table_assignment_queue_v9", {
        _search: deferredSearch,
        _batch: batchFilter ? Number(batchFilter) : null,
        _pilot_mode: pilotMode,
        _limit: PAGE_SIZE,
        _offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return (data ?? []) as QueueRow[];
    },
  });

  function refresh() {
    for (const key of [
      "table-assignment-queue-v9",
      "assignment-batch-summary-v9",
      "daftar-tabel",
      "review-queue",
      "review-counts",
      "tabel",
      "review-detail",
      "progres",
      "dashboard-v8",
    ]) queryClient.invalidateQueries({ queryKey: [key] });
  }

  const assignOne = useMutation({
    mutationFn: async ({ sourceId, annotatorId, validatorId }: {
      sourceId: string;
      annotatorId: string | null;
      validatorId: string | null;
    }) => {
      const { data, error } = await supabase.rpc("admin_assign_tables_with_qa", {
        _source_ids: [sourceId],
        _annotator_id: annotatorId,
        _validator_id: validatorId,
        _change_annotator: true,
        _change_validator: true,
      });
      if (error) throw error;
      return data as AssignmentResult;
    },
    onSuccess: (r) => {
      toast.success(`${r.tables_assigned} tabel dan ${r.qa_assigned} QA diperbarui.`);
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal memperbarui penugasan."),
  });

  const assignBatch = useMutation({
    mutationFn: async () => {
      if (!batchToAssign) throw new Error("Pilih batch terlebih dahulu.");
      if (batchAnnotator === KEEP && batchValidator === KEEP) throw new Error("Pilih Anotator atau Validator yang ingin diubah.");
      const { data, error } = await supabase.rpc("admin_assign_batch_with_qa", {
        _batch: Number(batchToAssign),
        _annotator_id: batchAnnotator === KEEP || batchAnnotator === NONE ? null : batchAnnotator,
        _validator_id: batchValidator === KEEP || batchValidator === NONE ? null : batchValidator,
        _change_annotator: batchAnnotator !== KEEP,
        _change_validator: batchValidator !== KEEP,
        _pilot_mode: batchPilotMode,
      });
      if (error) throw error;
      return data as AssignmentResult;
    },
    onSuccess: (r) => {
      toast.success(`Batch ${r.batch}: ${r.tables_assigned} tabel dan ${r.qa_assigned} QA ditugaskan.`);
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Penugasan batch gagal; tidak ada perubahan disimpan."),
  });

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert">Gagal memuat peran pengguna.</p>;
  if (!isAdmin) return <p role="alert">Halaman ini hanya untuk Admin.</p>;

  const eligible = users.data ?? [];
  const annotators = eligible.filter((u) => u.roles.some((r) => ["admin", "validator", "anotator"].includes(r)));
  const validators = eligible.filter((u) => u.roles.some((r) => ["admin", "validator"].includes(r)));
  const batches = batchSummary.data ?? [];
  const rows = queue.data ?? [];
  const total = Number(rows[0]?.total_count ?? 0);
  const busy = assignOne.isPending || assignBatch.isPending;

  return <section className="mx-auto max-w-6xl">
    <PageHeading
      eyebrow="b · penugasan"
      title="Penugasan berbasis tabel"
      right={<span className="font-mono text-xs text-mist">{total} tabel</span>}
    />
    <p className="mb-5 max-w-3xl text-sm text-mist">
      Penugasan hanya dilakukan pada tabel. Semua QA dalam sampel yang terhubung ke tabel otomatis mengikuti
      Anotator dan Validator tabel tersebut. Gunakan batch yang sudah disediakan untuk penugasan cepat,
      atau ubah satu tabel secara manual. Flag Pilot tidak mengubah struktur sumber dan dapat difilter terpisah.
    </p>

    <div className="panel mb-5 space-y-4 p-4">
      <div>
        <h2 className="font-semibold">Tugaskan berdasarkan batch</h2>
        <p className="mt-1 text-xs text-mist">
          Satu batch diproses sebagai satu transaksi database. Jika satu item gagal (misalnya review sudah dimulai
          oleh validator lain), seluruh perubahan batch dibatalkan.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-5 md:items-end">
        <label className="space-y-1 text-xs">Batch
          <select value={batchToAssign} onChange={(e) => setBatchToAssign(e.target.value)}
            className="block w-full rounded-lg bg-frost p-2 text-sm ring-1 ring-line">
            <option value="">Pilih batch</option>
            {batches.map((b) => <option key={b.batch_no} value={b.batch_no}>
              Batch {b.batch_no} · {b.tables} tabel · {b.qa} QA
            </option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">Cakupan
          <select value={batchPilotMode} onChange={(e) => setBatchPilotMode(e.target.value as PilotMode)}
            className="block w-full rounded-lg bg-frost p-2 text-sm ring-1 ring-line">
            <option value="all">Semua tabel batch</option>
            <option value="pilot">Pilot saja</option>
            <option value="nonpilot">Non-pilot saja</option>
          </select>
        </label>
        <label className="space-y-1 text-xs">Anotator
          <select value={batchAnnotator} onChange={(e) => setBatchAnnotator(e.target.value)}
            className="block w-full rounded-lg bg-frost p-2 text-sm ring-1 ring-line">
            <option value={KEEP}>Jangan ubah</option>
            <option value={NONE}>Kosongkan</option>
            {annotators.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">Validator
          <select value={batchValidator} onChange={(e) => setBatchValidator(e.target.value)}
            className="block w-full rounded-lg bg-frost p-2 text-sm ring-1 ring-line">
            <option value={KEEP}>Jangan ubah</option>
            <option value={NONE}>Kosongkan</option>
            {validators.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
          </select>
        </label>
        <button type="button"
          disabled={busy || !batchToAssign || (batchAnnotator === KEEP && batchValidator === KEEP)}
          onClick={() => {
            const label = batchPilotMode === "all" ? "semua tabel" : batchPilotMode === "pilot" ? "tabel pilot" : "tabel non-pilot";
            if (!window.confirm(`Tugaskan ${label} pada Batch ${batchToAssign}? QA terkait otomatis mengikuti.`)) return;
            assignBatch.mutate();
          }}
          className="rounded-lg bg-teal px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40">
          {assignBatch.isPending ? "Menyimpan…" : "Tugaskan batch"}
        </button>
      </div>

      {batches.length > 0 && <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-left text-xs">
          <thead><tr className="border-b border-line/70 label-mono">
            <th className="p-2">Batch</th><th className="p-2">Tabel</th><th className="p-2">QA</th>
            <th className="p-2">Pilot</th><th className="p-2">Sudah ada assignment</th>
          </tr></thead>
          <tbody>{batches.map((b) => <tr key={b.batch_no} className="border-b border-line/40">
            <td className="p-2 font-mono">{b.batch_no}</td><td className="p-2">{b.tables}</td><td className="p-2">{b.qa}</td>
            <td className="p-2">{b.pilot_tables} tabel / {b.pilot_qa} QA</td><td className="p-2">{b.assigned_tables} tabel</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </div>

    <div className="mb-4 flex flex-wrap gap-2">
      <select value={batchFilter} onChange={(e) => setBatchFilter(e.target.value)}
        className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line">
        <option value="">Semua batch</option>
        {batches.map((b) => <option key={b.batch_no} value={b.batch_no}>Batch {b.batch_no}</option>)}
      </select>
      <select value={pilotMode} onChange={(e) => setPilotMode(e.target.value as PilotMode)}
        className="rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line">
        <option value="all">Pilot + non-pilot</option><option value="pilot">Pilot saja</option><option value="nonpilot">Non-pilot saja</option>
      </select>
      <input value={search} onChange={(e) => setSearch(e.target.value)}
        placeholder="Cari ID atau judul tabel…" className="min-w-64 flex-1 rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line" />
    </div>

    {users.error && <p role="alert" className="mb-4 text-sm text-amber">Gagal memuat pengguna: {users.error.message}</p>}
    {batchSummary.error && <p role="alert" className="mb-4 text-sm text-amber">Gagal memuat batch: {batchSummary.error.message}</p>}
    {queue.error && <p role="alert" className="mb-4 text-sm text-amber">{queue.error.message}</p>}

    <div className="panel overflow-x-auto"><table className="w-full min-w-[980px] text-left text-sm">
      <thead><tr className="border-b border-line/70 label-mono">
        <th className="p-3">ID tabel</th><th className="p-3">Batch</th><th className="p-3">Pilot</th>
        <th className="p-3">Judul</th><th className="p-3">QA</th><th className="p-3">Anotator</th><th className="p-3">Validator</th>
      </tr></thead>
      <tbody>{queue.isPending ? <tr><td colSpan={7} className="p-6 text-center text-mist">Memuat…</td></tr> : rows.map((row) =>
        <AssignmentRow key={`${row.item_id}:${row.annotator_id}:${row.validator_id}`}
          row={row} annotators={annotators} validators={validators} busy={busy}
          onSave={(a, v) => {
            const changing = a !== row.annotator_id || v !== row.validator_id;
            const alreadyAssigned = row.annotator_id !== null || row.validator_id !== null;
            if (changing && alreadyAssigned && !window.confirm("Ubah penugasan tabel ini? Semua QA sampel terkait akan ikut berubah.")) return;
            assignOne.mutate({ sourceId: row.source_id!, annotatorId: a, validatorId: v });
          }} />
      )}</tbody>
    </table></div>

    <div className="mt-4 flex justify-between font-mono text-xs text-mist">
      <span>{total ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} dari ${total}` : "0 tabel"}</span>
      <div className="flex gap-2">
        <button disabled={busy || page === 0} onClick={() => setPage((p) => p - 1)}
          className="rounded-lg px-3 py-2 ring-1 ring-line disabled:opacity-40">←</button>
        <button disabled={busy || (page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}
          className="rounded-lg px-3 py-2 ring-1 ring-line disabled:opacity-40">→</button>
      </div>
    </div>
  </section>;
}

function AssignmentRow({ row, annotators, validators, onSave, busy }: {
  row: QueueRow;
  annotators: UserOption[];
  validators: UserOption[];
  onSave: (a: string | null, v: string | null) => void;
  busy: boolean;
}) {
  const [annotator, setAnnotator] = useState(row.annotator_id ?? "");
  const [validator, setValidator] = useState(row.validator_id ?? "");
  useEffect(() => setAnnotator(row.annotator_id ?? ""), [row.annotator_id]);
  useEffect(() => setValidator(row.validator_id ?? ""), [row.validator_id]);

  return <tr className="border-b border-line/50 last:border-b-0">
    <td className="p-3 font-mono text-xs text-cyan">{row.source_id || "—"}</td>
    <td className="p-3 font-mono text-xs">{row.batch_no ?? "—"}</td>
    <td className="p-3">{row.is_pilot
      ? <span className="rounded-full bg-amber/15 px-2 py-1 text-xs text-amber">Pilot</span>
      : <span className="text-xs text-mist">—</span>}</td>
    <td className="p-3"><div className="font-mono text-xs text-mist">{row.table_code}</div><div className="line-clamp-2">{row.source_text}</div></td>
    <td className="p-3 font-mono text-xs">{row.qa_count}</td>
    <td className="p-3"><select aria-label={`Anotator ${row.source_id}`} value={annotator}
      onChange={(e) => setAnnotator(e.target.value)} className="w-full rounded-lg bg-frost p-2 text-xs ring-1 ring-line">
      <option value="">Belum ditugaskan</option>
      {annotators.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
    </select></td>
    <td className="p-3"><div className="flex gap-2"><select aria-label={`Validator ${row.source_id}`} value={validator}
      onChange={(e) => setValidator(e.target.value)} className="w-full rounded-lg bg-frost p-2 text-xs ring-1 ring-line">
      <option value="">Belum ditugaskan</option>
      {validators.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
    </select><button type="button" disabled={busy || !row.source_id || (annotator !== "" && annotator === validator)}
      onClick={() => onSave(annotator || null, validator || null)}
      className="rounded-lg bg-teal px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40">Simpan</button></div></td>
  </tr>;
}
