import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeading } from "@/components/AppShell";
import { roleLabel, useCurrentUser, type AppRole } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/pengguna")({
  head: () => ({
    meta: [
      { title: "Kelola Pengguna — HiTab TQA" },
      {
        name: "description",
        content:
          "Kelola anggota tim anotasi HiTab TQA: peran Admin, Validator, Anotator, serta status keaktifan.",
      },
      { property: "og:title", content: "Kelola Pengguna — HiTab TQA" },
      {
        property: "og:description",
        content: "Kelola anggota tim anotasi HiTab TQA beserta peran dan statusnya.",
      },
    ],
  }),
  component: UsersPage,
});

const roles: AppRole[] = ["admin", "validator", "anotator"];

function UsersPage() {
  const { isAdmin, userId, rolesLoading, rolesError } = useCurrentUser();
  const queryClient = useQueryClient();
  const [sourceId,setSourceId] = useState("");
  const [sampleKind,setSampleKind] = useState<"table"|"qa">("table");
  const [sampleFlag,setSampleFlag] = useState<0|1>(1);
  const [logUser,setLogUser] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["pengguna"],
    enabled: isAdmin,
    queryFn: async () => {
      const [profiles, userRoles, cells, qa] = await Promise.all([
        supabase.from("profiles").select("id, full_name, email, status").order("full_name"),
        supabase.from("user_roles").select("user_id, role"),
        supabase.from("table_cells").select("id, updated_by, target_text"),
        supabase.from("qa_pairs").select("id, updated_by, question_id"),
      ]);
      if (profiles.error) throw profiles.error;
      if (userRoles.error) throw userRoles.error;
      if (cells.error) throw cells.error;
      if (qa.error) throw qa.error;
      return {
        profiles: profiles.data ?? [],
        userRoles: userRoles.data ?? [],
        cells: cells.data ?? [],
        qa: qa.data ?? [],
      };
    },
  });

  const activity = useQuery({
    queryKey: ["user-work-log", logUser],
    enabled: isAdmin,
    queryFn: async () => {
      let query = supabase.from("user_work_log")
        .select("id,actor_id,actor_role,item_type,source_table_id,source_question_id,action,occurred_at")
        .order("occurred_at",{ascending:false}).limit(100);
      if (logUser) query = query.eq("actor_id",logUser);
      const {data,error} = await query;
      if (error) throw error;
      return data ?? [];
    },
  });

  const sample = useMutation({
    mutationFn: async () => {
      if (!sourceId.trim()) throw new Error("Masukkan ID asli tabel atau QA.");
      const {error} = await supabase.rpc("hitab_set_sampling",{
        _kind:sampleKind,_source_id:sourceId.trim(),_flag:sampleFlag,
      });
      if (error) throw error;
    },
    onSuccess:()=>{
      toast.success("Sampling diperbarui.");
      queryClient.invalidateQueries({queryKey:["daftar-tabel"]});
      queryClient.invalidateQueries({queryKey:["review-queue"]});
      queryClient.invalidateQueries({queryKey:["progres"]});
    },
    onError:(error)=>toast.error(error instanceof Error ? error.message : "Gagal memperbarui sampling."),
  });

  const setRole = useMutation({
    mutationFn: async ({ id, nextRoles }: { id: string; nextRoles: AppRole[] }) => {
      const { error } = await supabase.rpc("admin_set_user_roles", { _user_id: id, _roles: nextRoles });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Peran diperbarui.");
      queryClient.invalidateQueries({ queryKey: ["pengguna"] });
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      queryClient.invalidateQueries({ queryKey: ["assignment-users"] });
      queryClient.invalidateQueries({ queryKey: ["progres"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal menyimpan."),
  });

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase.from("profiles").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Status diperbarui.");
      queryClient.invalidateQueries({ queryKey: ["pengguna"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal menyimpan."),
  });

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert">Gagal memuat peran.</p>;
  if (!isAdmin) return <p role="alert">Halaman ini hanya untuk Admin.</p>;
  if (isLoading || !data) return <span className="label-mono">Memuat daftar pengguna…</span>;

  const countFor = (id: string) =>
    data.cells.filter((c) => c.updated_by === id && (c.target_text ?? "").trim()).length +
    data.qa.filter((q) => q.updated_by === id && (q.question_id ?? "").trim()).length;

  return (
    <section>
      <PageHeading
        eyebrow="b · manajemen pengguna"
        title="Tim & peran"
        right={
          <div className="font-mono text-[11px] text-mist">
            {isAdmin ? "Anda dapat mengubah peran & status" : "Hanya Admin dapat mengubah data"}
          </div>
        }
      />

      <div className="panel overflow-hidden">
        <div className="grid grid-cols-[1fr_10rem_7rem_7rem] gap-3 border-b border-line/70 px-4 py-2">
          <span className="label-mono">Nama</span>
          <span className="label-mono">Peran</span>
          <span className="label-mono">Entri</span>
          <span className="label-mono">Status</span>
        </div>

        {data.profiles.map((profile) => {
          const profileRoles = data.userRoles.filter((r) => r.user_id === profile.id).map((r) => r.role as AppRole);
          return (
            <div
              key={profile.id}
              className="grid grid-cols-[1fr_10rem_7rem_7rem] items-center gap-3 border-b border-line/50 px-4 py-2.5 text-sm transition-colors last:border-b-0 hover:bg-ink/5"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {profile.full_name || "(tanpa nama)"}
                  {profile.id === userId && <span className="ml-2 text-xs text-mist">· Anda</span>}
                </div>
                <div className="truncate font-mono text-[11px] text-mist">{profile.email}</div>
              </div>

              <div className="flex flex-col gap-1" aria-label={`Peran ${profile.full_name || profile.email}`}>
                {roles.map((r) => <label key={r} className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={profileRoles.includes(r)} disabled={setRole.isPending}
                    onChange={(e) => setRole.mutate({
                      id: profile.id,
                      nextRoles: e.target.checked ? [...profileRoles, r] : profileRoles.filter((existing) => existing !== r),
                    })} />
                  {roleLabel[r]}
                </label>)}
                {!profileRoles.length && <span className="text-[10px] text-mist">Belum ditetapkan</span>}
              </div>

              <span className="font-mono text-xs">{countFor(profile.id)}</span>

              {isAdmin ? (
                <select
                  value={profile.status}
                  onChange={(e) => setStatus.mutate({ id: profile.id, status: e.target.value })}
                  className="rounded-lg bg-paper/80 px-2 py-1 font-mono text-xs ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
                >
                  <option value="menunggu_peran">menunggu_peran</option>
                  <option value="aktif">aktif</option>
                  <option value="cuti">cuti</option>
                  <option value="nonaktif">nonaktif</option>
                </select>
              ) : (
                <span
                  className={`text-xs ${profile.status === "aktif" ? "text-teal" : "text-amber"}`}
                >
                  ● {profile.status}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="panel mt-6 space-y-3 p-4">
        <h2 className="font-display text-lg font-semibold">Sampling anotasi</h2>
        <p className="text-xs text-mist">Tabel dan QA disampel terpisah. ID asli ≠ UUID internal; 1 masuk sampel, 0 tidak.</p>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Jenis sampel" value={sampleKind} onChange={(e)=>setSampleKind(e.target.value as "table"|"qa")}
            className="rounded-lg bg-frost p-2 text-sm ring-1 ring-line">
            <option value="table">Tabel</option><option value="qa">QA</option>
          </select>
          <input aria-label="ID asli" value={sourceId} onChange={(e)=>setSourceId(e.target.value)}
            placeholder="ID asli HiTAB" className="min-w-40 flex-1 rounded-lg bg-frost p-2 text-sm ring-1 ring-line" />
          <select aria-label="Flag sampel" value={sampleFlag} onChange={(e)=>setSampleFlag(Number(e.target.value) as 0|1)}
            className="rounded-lg bg-frost p-2 text-sm ring-1 ring-line">
            <option value={1}>1 · Disampel</option><option value={0}>0 · Tidak disampel</option>
          </select>
          <button type="button" disabled={sample.isPending || !sourceId.trim()} onClick={()=>sample.mutate()}
            className="rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40">Simpan flag</button>
        </div>
      </div>

      <div className="panel mt-6 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 p-4">
          <h2 className="font-display text-lg font-semibold">Log aktivitas anotator & validator</h2>
          <select aria-label="Filter pengguna" value={logUser} onChange={(e)=>setLogUser(e.target.value)}
            className="rounded-lg bg-frost p-2 text-sm ring-1 ring-line">
            <option value="">Semua pengguna</option>
            {data.profiles.map((p)=><option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
          </select>
        </div>
        {activity.error && <p role="alert" className="p-4 text-sm">Gagal memuat log: {activity.error.message}</p>}
        <div className="max-h-96 overflow-auto">
          <table className="w-full min-w-[600px] text-left text-xs">
            <thead><tr className="border-b border-line/70"><th className="p-3">Waktu</th><th className="p-3">Pengguna</th><th className="p-3">Peran</th><th className="p-3">Item</th><th className="p-3">Aksi</th></tr></thead>
            <tbody>{(activity.data ?? []).map((event)=><tr key={event.id} className="border-b border-line/50">
              <td className="p-3">{new Date(event.occurred_at).toLocaleString("id-ID")}</td>
              <td className="p-3">{data.profiles.find((p)=>p.id===event.actor_id)?.full_name || event.actor_id || "system"}</td>
              <td className="p-3">{event.actor_role}</td>
              <td className="p-3 font-mono">{event.item_type} · {event.source_question_id || event.source_table_id || "ID lama"}</td>
              <td className="p-3">{event.action}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="p-3 text-xs text-mist">100 aktivitas terbaru. Before/after lengkap tersimpan di database untuk audit.</p>
      </div>

      <p className="mt-3 font-mono text-[11px] text-mist">
        Anggota baru dapat mendaftar sendiri, tetapi tidak memperoleh peran kerja otomatis. Admin menetapkan Anotator, Validator, atau Admin dari halaman ini.
      </p>
    </section>
  );
}
