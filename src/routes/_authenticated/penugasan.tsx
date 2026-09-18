import { createFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
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
const PAGE_SIZE = 30;

function AssignmentPage() {
  const { isAdmin, rolesLoading } = useCurrentUser();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<Kind>("table");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [page, setPage] = useState(0);

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
      const roleMap = new Map((roles.data ?? []).map((r) => [r.user_id, r.role]));
      return (profiles.data ?? []).map((p) => ({ ...p, role: roleMap.get(p.id) ?? null }));
    },
  });

  const queue = useQuery({
    queryKey: ["assignment-queue", kind, deferredSearch, page],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("assignment_queue", {
        _kind: kind,
        _search: deferredSearch,
        _limit: PAGE_SIZE,
        _offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return data ?? [];
    },
  });

  const assign = useMutation({
    mutationFn: async ({ sourceId, annotatorId, validatorId }: { sourceId: string; annotatorId: string | null; validatorId: string | null }) => {
      const { error } = await supabase.rpc("admin_assign_work", {
        _kind: kind,
        _source_id: sourceId,
        _annotator_id: annotatorId,
        _validator_id: validatorId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Penugasan diperbarui.");
      queryClient.invalidateQueries({ queryKey: ["assignment-queue"] });
      queryClient.invalidateQueries({ queryKey: ["daftar-tabel"] });
      queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal memperbarui penugasan."),
  });

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (!isAdmin) return <p role="alert">Halaman ini hanya untuk Admin.</p>;

  const annotators = (users.data ?? []).filter((u) => u.role === "anotator");
  const validators = (users.data ?? []).filter((u) => u.role === "validator");
  const rows = queue.data ?? [];
  const total = rows[0]?.total_count ?? 0;

  return (
    <section className="mx-auto max-w-6xl">
      <PageHeading eyebrow="b · penugasan" title="Penugasan anotator & validator" right={<span className="font-mono text-xs text-mist">{total} entri</span>} />
      <p className="mb-5 max-w-3xl text-sm text-mist">
        Penugasan dilakukan terpisah untuk tabel dan QA menggunakan ID asli HiTAB. Hanya Anotator/Validator aktif yang dapat dipilih. Item tanpa penugasan tidak muncul di ruang kerja pengguna tersebut.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => { setKind("table"); setPage(0); }} className={`rounded-full px-4 py-2 text-xs ring-1 ${kind === "table" ? "bg-teal/15 text-teal ring-teal/30" : "ring-line"}`}>Tabel</button>
        <button type="button" onClick={() => { setKind("qa"); setPage(0); }} className={`rounded-full px-4 py-2 text-xs ring-1 ${kind === "qa" ? "bg-teal/15 text-teal ring-teal/30" : "ring-line"}`}>QA</button>
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="Cari ID, kode tabel, atau teks…" className="min-w-64 flex-1 rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line" />
      </div>

      {queue.error && <p role="alert" className="mb-4 text-sm text-amber">{queue.error.message}</p>}
      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead><tr className="border-b border-line/70 label-mono"><th className="p-3">ID asli</th><th className="p-3">Item</th><th className="p-3">Sampling</th><th className="p-3">Anotator</th><th className="p-3">Validator</th></tr></thead>
          <tbody>
            {queue.isPending ? <tr><td colSpan={5} className="p-6 text-center text-mist">Memuat…</td></tr> : rows.map((row) => (
              <AssignmentRow key={row.item_id} row={row} annotators={annotators} validators={validators} onSave={(a, v) => assign.mutate({ sourceId: row.source_id ?? "", annotatorId: a, validatorId: v })} busy={assign.isPending} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex justify-between font-mono text-xs text-mist">
        <span>{total ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} dari ${total}` : "0 entri"}</span>
        <div className="flex gap-2"><button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="rounded-lg px-3 py-2 ring-1 ring-line disabled:opacity-40">←</button><button disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)} className="rounded-lg px-3 py-2 ring-1 ring-line disabled:opacity-40">→</button></div>
      </div>
    </section>
  );
}

type UserOption = { id: string; full_name: string; email: string; role: string | null };
type QueueRow = {
  item_id: string; source_id: string | null; table_code: string; source_text: string; annotate_flag: number;
  annotator_id: string | null; validator_id: string | null; total_count: number;
};

function AssignmentRow({ row, annotators, validators, onSave, busy }: { row: QueueRow; annotators: UserOption[]; validators: UserOption[]; onSave: (a: string | null, v: string | null) => void; busy: boolean }) {
  const [annotator, setAnnotator] = useState(row.annotator_id ?? "");
  const [validator, setValidator] = useState(row.validator_id ?? "");
  return <tr className="border-b border-line/50 last:border-b-0">
    <td className="p-3 font-mono text-xs text-cyan">{row.source_id || "—"}</td>
    <td className="p-3"><div className="font-mono text-xs text-mist">{row.table_code}</div><div className="line-clamp-2">{row.source_text}</div></td>
    <td className="p-3 font-mono text-xs">{row.annotate_flag === 1 ? "1 · ya" : "0 · tidak"}</td>
    <td className="p-3"><select value={annotator} onChange={(e) => setAnnotator(e.target.value)} className="w-full rounded-lg bg-frost p-2 text-xs ring-1 ring-line"><option value="">Belum ditugaskan</option>{annotators.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}</select></td>
    <td className="p-3"><div className="flex gap-2"><select value={validator} onChange={(e) => setValidator(e.target.value)} className="w-full rounded-lg bg-frost p-2 text-xs ring-1 ring-line"><option value="">Belum ditugaskan</option>{validators.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}</select><button type="button" disabled={busy || !row.source_id} onClick={() => onSave(annotator || null, validator || null)} className="rounded-lg bg-teal px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40">Simpan</button></div></td>
  </tr>;
}
