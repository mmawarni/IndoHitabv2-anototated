import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { roleLabel, useCurrentUser } from "@/hooks/useAuth";

type MenuItem = { to: "/dasbor" | "/terjemahan" | "/pemeriksaan" | "/pengguna"; label: string };

function MenuGroup({ label, items }: { label: string; items: MenuItem[] }) {
  if (!items.length) return null;
  return (
    <div className="mb-7">
      <div className="label-mono mb-3 tracking-[0.2em]">{label}</div>
      <nav className="space-y-1 text-sm" aria-label={label}>
        {items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-mist transition-colors hover:bg-ink/5"
            activeProps={{ className: "flex items-center gap-3 rounded-xl px-3 py-2.5 bg-teal/10 text-teal font-semibold ring-1 ring-teal/20" }}
            activeOptions={{ exact: item.to === "/dasbor" }}
          >
            <span className="size-1.5 shrink-0 rounded-full bg-current opacity-60" />
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile, email, roles, isAdmin, isValidator } = useCurrentUser();
  const canTranslate = isAdmin || roles.includes("anotator");
  const canValidate = isAdmin || isValidator;

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/", replace: true });
  }

  return (
    <div className="flex min-h-screen bg-paper text-ink">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col overflow-y-auto border-r border-line/70 bg-frost/50 p-4 backdrop-blur-md md:w-64">
        <div className="mb-10 flex items-center gap-3">
          <span className="font-display grid size-9 place-items-center rounded-xl bg-teal/15 text-lg font-bold text-teal ring-1 ring-teal/30">H</span>
          <div>
            <div className="font-display text-base leading-none font-semibold">HiTab TQA</div>
            <div className="label-mono mt-1">Panel anotasi</div>
          </div>
        </div>
        <MenuGroup label="Umum" items={[{ to: "/dasbor", label: "Dasbor" }]} />
        <MenuGroup label="Anotator" items={canTranslate ? [{ to: "/terjemahan", label: "Penerjemahan" }] : []} />
        <MenuGroup label="Validator" items={canValidate ? [{ to: "/pemeriksaan", label: "Pemeriksaan" }] : []} />
        <MenuGroup label="Pengaturan" items={isAdmin ? [{ to: "/pengguna", label: "Pengguna" }] : []} />
        <div className="mt-auto space-y-2 border-t border-line/70 pt-4">
          <div className="label-mono">Masuk sebagai</div>
          <div className="truncate text-sm font-medium">{profile?.full_name || email}</div>
          <div className="font-mono text-xs text-mist">
            {roles.length ? roles.map((r) => roleLabel[r]).join(" · ") : "Memuat peran…"}
          </div>
          <button onClick={handleSignOut} className="w-full rounded-lg px-3 py-1.5 font-mono text-[11px] text-mist ring-1 ring-line transition-colors hover:bg-ink/5">Keluar</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 space-y-8 p-4 md:p-8">{children}</main>
    </div>
  );
}

export function PageHeading({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <div className="label-mono">{eyebrow}</div>
        <h1 className="font-display text-xl font-bold tracking-tight md:text-2xl">{title}</h1>
      </div>
      {right}
    </div>
  );
}
