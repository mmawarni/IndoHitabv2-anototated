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

  const setRole = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: AppRole }) => {
      const remove = await supabase.from("user_roles").delete().eq("user_id", id);
      if (remove.error) throw remove.error;
      const insert = await supabase.from("user_roles").insert({ user_id: id, role });
      if (insert.error) throw insert.error;
    },
    onSuccess: () => {
      toast.success("Peran diperbarui.");
      queryClient.invalidateQueries({ queryKey: ["pengguna"] });
      queryClient.invalidateQueries({ queryKey: ["roles"] });
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
        <div className="grid grid-cols-[1fr_9rem_7rem_7rem] gap-3 border-b border-line/70 px-4 py-2">
          <span className="label-mono">Nama</span>
          <span className="label-mono">Peran</span>
          <span className="label-mono">Entri</span>
          <span className="label-mono">Status</span>
        </div>

        {data.profiles.map((profile) => {
          const role =
            (data.userRoles.find((r) => r.user_id === profile.id)?.role as AppRole | undefined) ??
            "anotator";
          return (
            <div
              key={profile.id}
              className="grid grid-cols-[1fr_9rem_7rem_7rem] items-center gap-3 border-b border-line/50 px-4 py-2.5 text-sm transition-colors last:border-b-0 hover:bg-ink/5"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {profile.full_name || "(tanpa nama)"}
                  {profile.id === userId && <span className="ml-2 text-xs text-mist">· Anda</span>}
                </div>
                <div className="truncate font-mono text-[11px] text-mist">{profile.email}</div>
              </div>

              {isAdmin ? (
                <select
                  value={role}
                  onChange={(e) => setRole.mutate({ id: profile.id, role: e.target.value as AppRole })}
                  className="rounded-lg bg-paper/80 px-2 py-1 font-mono text-xs ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
                >
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel[r]}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="font-mono text-xs text-teal">{roleLabel[role]}</span>
              )}

              <span className="font-mono text-xs">{countFor(profile.id)}</span>

              {isAdmin ? (
                <select
                  value={profile.status}
                  onChange={(e) => setStatus.mutate({ id: profile.id, status: e.target.value })}
                  className="rounded-lg bg-paper/80 px-2 py-1 font-mono text-xs ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
                >
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

      <p className="mt-3 font-mono text-[11px] text-mist">
        Anggota baru bergabung lewat halaman pendaftaran dan otomatis berperan Anotator.
      </p>
    </section>
  );
}
