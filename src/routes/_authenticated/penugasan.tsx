import { createFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeading } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/penugasan")({
  head: () => ({ meta: [{ title: "Penugasan — HiTab TQA" }] }),
  component: AssignmentPage,
});

type Kind = "table" | "qa";
type UserOption = { id: string; full_name: string; email: string; roles: string[] };
type QueueRow = {
  item_id: string; source_id: string | null; table_code: string; source_text: string; annotate_flag: number;
  annotator_id: string | null; validator_id: string | null; total_count: number;
};
type TableAssignmentResult = { tables_assigned: number; qa_assigned: number; qa_excluded_by_sampling: number };
const PAGE_SIZE = 30;
const KEEP = "__keep__";
const NONE = "__none__";

function AssignmentPage() {
  const { isAdmin, rolesLoading, rolesError } = useCurrentUser();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<Kind>("table");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkAnnotator, setBulkAnnotator] = useState(KEEP);
  const [bulkValidator, setBulkValidator] = useState(KEEP);
  // Selection is deliberately page-scoped; changing the queue clears it.
  useEffect(() => { setSelected([]); }, [kind, deferredSearch, page]);

  const users = useQuery({
    queryKey: ["assignment-users"], enabled: isAdmin,
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
        id: profile.id, full_name: profile.full_name, email: profile.email,
        roles: roleMap.get(profile.id) ?? [],
      }));
    },
  });

  const queue = useQuery({
    queryKey: ["assignment-queue", kind, deferredSearch, page], enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("assignment_queue", {
        _kind: kind, _search: deferredSearch, _limit: PAGE_SIZE, _offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return data ?? [];
    },
  });

  function refresh() {
    for (const key of ["assignment-queue", "daftar-tabel", "review-queue", "review-counts", "tabel", "review-detail", "progres"]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  }

  const assign = useMutation({
    mutationFn: async ({ sourceId, annotatorId, validatorId }: {
      sourceId: string; annotatorId: string | null; validatorId: string | null;
    }) => {
      if (kind === "table") {
        const { data, error } = await supabase.rpc("admin_assign_tables_with_qa", {
          _source_ids: [sourceId], _annotator_id: annotatorId, _validator_id: validatorId,
          _change_annotator: true, _change_validator: true,
        });
        if (error) throw error;
        return data as TableAssignmentResult;
      }
      const { error } = await supabase.rpc("admin_assign_work", {
        _kind: "qa", _source_id: sourceId, _annotator_id: annotatorId, _validator_id: validatorId,
      });
      if (error) throw error;
      return null;
    },
    onSuccess: (result) => { toast.success(result ? `Penugasan diperbarui: ${result.qa_assigned} QA ikut ditugaskan.` : "Penugasan QA diperbarui."); refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal memperbarui penugasan."),
  });

  const bulk = useMutation({
    mutationFn: async () => {
      const visibleIds = new Set((queue.data ?? []).map((r) => r.source_id).filter((id): id is string => !!id));
      const ids = selected.filter((id) => visibleIds.has(id));
      if (!ids.length) throw new Error("Pilih setidaknya satu item pada halaman ini.");
      if (bulkAnnotator === KEEP && bulkValidator === KEEP) throw new Error("Pilih Anotator atau Validator yang ingin diubah.");
      const { data, error } = await supabase.rpc(
        kind === "table" ? "admin_assign_tables_with_qa" : "admin_bulk_assign_work", {
        ...(kind === "qa" ? { _kind: "qa" } : {}), _source_ids: ids,
        _annotator_id: bulkAnnotator === KEEP || bulkAnnotator === NONE ? null : bulkAnnotator,
        _validator_id: bulkValidator === KEEP || bulkValidator === NONE ? null : bulkValidator,
        _change_annotator: bulkAnnotator !== KEEP, _change_validator: bulkValidator !== KEEP,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (count) => {
      const result = kind === "table" ? count as TableAssignmentResult : null;
      toast.success(result
        ? `${result.tables_assigned} tabel dan ${result.qa_assigned} QA ditugaskan (${result.qa_excluded_by_sampling} QA di luar sampel dilewati).`
        : `${count} QA berhasil ditugaskan.`);
      setSelected([]); setBulkAnnotator(KEEP); setBulkValidator(KEEP); refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Penugasan massal gagal; tidak ada item yang diubah."),
  });

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert">Gagal memuat peran pengguna.</p>;
  if (!isAdmin) return <p role="alert">Halaman ini hanya untuk Admin.</p>;

  const eligible = users.data ?? [];
  const annotators = eligible.filter((u) => u.roles.some((r) => ["admin", "validator", "anotator"].includes(r)));
  const validators = eligible.filter((u) => u.roles.some((r) => ["admin", "validator"].includes(r)));
  const rows = queue.data ?? [];
  const total = rows[0]?.total_count ?? 0;
  const selectable = rows.filter((r) => !!r.source_id).map((r) => r.source_id!);
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.includes(id));
  const busy = assign.isPending || bulk.isPending;

  return <section className="mx-auto max-w-6xl">
    <PageHeading eyebrow="b · penugasan" title="Penugasan anotator & validator"
      right={<span className="font-mono text-xs text-mist">{total} entri</span>} />
    <p className="mb-5 max-w-3xl text-sm text-mist">
      Penugasan tabel otomatis menugaskan seluruh QA terkait yang masuk sampel (flag = 1),
      berdasarkan relasi table_id. ID tabel dan ID pertanyaan tetap berbeda. QA dengan penugasan lama
      yang berbeda tidak akan ditimpa; transaksi dibatalkan. Validator dapat menjadi anotator;
      Admin dapat dipilih di kedua kolom. Anotator dan validator pada item yang sama harus berbeda.
    </p>
    <div className="mb-4 flex flex-wrap gap-2">
      <button type="button" onClick={() => { setKind("table"); setPage(0); setSelected([]); }}
        className={`rounded-full px-4 py-2 text-xs ring-1 ${kind === "table" ? "bg-teal/15 text-teal ring-teal/30" : "ring-line"}`}>Tabel</button>
      <button type="button" onClick={() => { setKind("qa"); setPage(0); setSelected([]); }}
        className={`rounded-full px-4 py-2 text-xs ring-1 ${kind === "qa" ? "bg-teal/15 text-teal ring-teal/30" : "ring-line"}`}>QA</button>
      <input value={search} onChange={(e) => { setSearch(e.target.value); setSelected([]); setPage(0); }}
        placeholder="Cari ID, kode tabel, atau teks…" className="min-w-64 flex-1 rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line" />
    </div>

    <div className="panel mb-4 space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Penugasan massal · {selected.length} item dipilih</h2>
        <button type="button" disabled={busy || selected.length === 0} onClick={() => setSelected([])}
          className="rounded-lg px-3 py-1.5 text-xs ring-1 ring-line disabled:opacity-40">Hapus pilihan</button>
      </div>
      <p className="text-xs text-mist">Pilih beberapa item di halaman ini. “Jangan ubah” mempertahankan penugasan lama; “Kosongkan” menghapus penugasan di kolom itu. {kind === "table" ? "QA terkait yang masuk sampel akan otomatis mengikuti; QA yang sudah ditugaskan berbeda harus diselesaikan dahulu di tab QA." : "Penugasan QA manual dapat berbeda, tetapi penugasan tabel berikutnya akan menolak konflik."} Semua perubahan diproses dalam satu transaksi.</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="space-y-1 text-xs">Anotator
          <select aria-label="Anotator massal" value={bulkAnnotator} onChange={(e) => setBulkAnnotator(e.target.value)}
            className="block w-full rounded-lg bg-frost p-2 text-sm ring-1 ring-line">
            <option value={KEEP}>Jangan ubah</option><option value={NONE}>Kosongkan penugasan</option>
            {annotators.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">Validator
          <select aria-label="Validator massal" value={bulkValidator} onChange={(e) => setBulkValidator(e.target.value)}
            className="block w-full rounded-lg bg-frost p-2 text-sm ring-1 ring-line">
            <option value={KEEP}>Jangan ubah</option><option value={NONE}>Kosongkan penugasan</option>
            {validators.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
          </select>
        </label>
        <button type="button" disabled={busy || !selected.length || (bulkAnnotator === KEEP && bulkValidator === KEEP)}
          onClick={() => bulk.mutate()} className="rounded-lg bg-teal px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40">
          {bulk.isPending ? "Menyimpan…" : `Tugaskan ${selected.length} item`}
        </button>
      </div>
    </div>

    {users.error && <p role="alert" className="mb-4 text-sm text-amber">Gagal memuat pengguna: {users.error.message}</p>}
    {queue.error && <p role="alert" className="mb-4 text-sm text-amber">{queue.error.message}</p>}
    <div className="panel overflow-x-auto"><table className="w-full min-w-[890px] text-left text-sm">
      <thead><tr className="border-b border-line/70 label-mono">
        <th className="p-3"><input type="checkbox" aria-label="Pilih semua di halaman ini" checked={allSelected}
          disabled={busy || !selectable.length} onChange={(e) => setSelected(e.target.checked ? selectable : [])} /></th>
        <th className="p-3">ID asli</th><th className="p-3">Item</th><th className="p-3">Sampling</th>
        <th className="p-3">Anotator</th><th className="p-3">Validator</th>
      </tr></thead>
      <tbody>{queue.isPending ? <tr><td colSpan={6} className="p-6 text-center text-mist">Memuat…</td></tr> : rows.map((row) =>
        <AssignmentRow key={`${row.item_id}:${row.annotator_id}:${row.validator_id}`}
          row={row} annotators={annotators} validators={validators} busy={busy}
          selected={!!row.source_id && selected.includes(row.source_id)}
          onSelect={(checked) => setSelected((prev) => !row.source_id ? prev : checked
            ? [...new Set([...prev, row.source_id])] : prev.filter((id) => id !== row.source_id))}
          onSave={(a, v) => assign.mutate({ sourceId: row.source_id!, annotatorId: a, validatorId: v })} />
      )}</tbody>
    </table></div>
    <div className="mt-4 flex justify-between font-mono text-xs text-mist">
      <span>{total ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} dari ${total}` : "0 entri"}</span>
      <div className="flex gap-2">
        <button disabled={busy || page === 0} onClick={() => { setPage((p) => p - 1); setSelected([]); }}
          className="rounded-lg px-3 py-2 ring-1 ring-line disabled:opacity-40">←</button>
        <button disabled={busy || (page + 1) * PAGE_SIZE >= total} onClick={() => { setPage((p) => p + 1); setSelected([]); }}
          className="rounded-lg px-3 py-2 ring-1 ring-line disabled:opacity-40">→</button>
      </div>
    </div>
  </section>;
}

function AssignmentRow({ row, annotators, validators, onSave, busy, selected, onSelect }: {
  row: QueueRow; annotators: UserOption[]; validators: UserOption[];
  onSave: (a: string | null, v: string | null) => void;
  busy: boolean; selected: boolean; onSelect: (checked: boolean) => void;
}) {
  const [annotator, setAnnotator] = useState(row.annotator_id ?? "");
  const [validator, setValidator] = useState(row.validator_id ?? "");
  return <tr className="border-b border-line/50 last:border-b-0">
    <td className="p-3"><input type="checkbox" aria-label={`Pilih ${row.source_id ?? row.item_id}`}
      checked={selected} disabled={busy || !row.source_id} onChange={(e) => onSelect(e.target.checked)} /></td>
    <td className="p-3 font-mono text-xs text-cyan">{row.source_id || "—"}</td>
    <td className="p-3"><div className="font-mono text-xs text-mist">{row.table_code}</div><div className="line-clamp-2">{row.source_text}</div></td>
    <td className="p-3 font-mono text-xs">{row.annotate_flag === 1 ? "1 · ya" : "0 · tidak"}</td>
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
