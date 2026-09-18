import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import { ClipboardCheck, Download, LayoutDashboard, Languages, ListChecks, LogOut, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { roleLabel, useCurrentUser } from "@/hooks/useAuth";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

type MenuItem = {
  to: "/dasbor" | "/terjemahan" | "/pemeriksaan" | "/pengguna" | "/penugasan" | "/ekspor";
  label: string;
  icon: ComponentType<{ className?: string }>;
};

function MenuGroup({ label, items }: { label: string; items: MenuItem[] }) {
  if (!items.length) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="font-mono text-[10px] tracking-[0.2em] uppercase">{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton asChild tooltip={item.label}>
                <Link
                  to={item.to}
                  activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground font-medium" }}
                  activeOptions={{ exact: item.to === "/dasbor" }}
                >
                  <item.icon className="size-4" />
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile, email, roles, isAdmin, isValidator } = useCurrentUser();
  const canTranslate = isAdmin || isValidator || roles.includes("anotator");
  const canValidate = isAdmin || isValidator;

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/", replace: true });
  }

  const displayName = profile?.full_name || email;
  const initials =
    displayName
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?";

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader className="p-3">
          <div className="flex items-center gap-3 px-1 py-1">
            <span className="font-display grid size-9 shrink-0 place-items-center rounded-xl bg-teal/20 text-lg font-bold text-sidebar-primary ring-1 ring-teal/40">
              H
            </span>
            <div className="group-data-[collapsible=icon]:hidden">
              <div className="font-display text-base leading-none font-semibold">HiTab TQA</div>
              <div className="mt-1 font-mono text-[10px] tracking-[0.18em] text-sidebar-foreground/60 uppercase">
                Panel anotasi
              </div>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <MenuGroup label="Umum" items={[{ to: "/dasbor", label: "Dasbor", icon: LayoutDashboard }]} />
          <MenuGroup
            label="Anotator"
            items={canTranslate ? [{ to: "/terjemahan", label: "Penerjemahan", icon: Languages }] : []}
          />
          <MenuGroup
            label="Validator"
            items={canValidate ? [{ to: "/pemeriksaan", label: "Pemeriksaan", icon: ClipboardCheck }] : []}
          />
          <MenuGroup label="Dataset" items={isAdmin ? [{ to: "/ekspor", label: "Ekspor dataset", icon: Download }] : []} />
          <MenuGroup
            label="Pengaturan"
            items={
              isAdmin
                ? [
                    { to: "/pengguna", label: "Pengguna & Peran", icon: Users },
                    { to: "/penugasan", label: "Penugasan", icon: ListChecks },
                  ]
                : []
            }
          />
        </SidebarContent>

        <SidebarFooter className="gap-2 p-3">
          <div className="flex items-center gap-2 rounded-full bg-paper/70 p-1.5 ring-1 ring-line/70 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-xl group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:ring-0">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-teal/15 font-mono text-xs font-semibold text-teal ring-1 ring-teal/30">
              {initials}
            </span>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <div className="truncate text-sm font-medium">{displayName}</div>
              <div className="truncate font-mono text-[10px] text-sidebar-foreground/60">
                {roles.length ? roles.map((r) => roleLabel[r]).join(" · ") : "Menunggu penetapan peran"}
              </div>
            </div>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={handleSignOut} tooltip="Keluar">
                <LogOut className="size-4" />
                <span>Keluar</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line/70 bg-frost px-4">
          <SidebarTrigger className="text-teal hover:bg-teal/10 hover:text-teal" />
          <div className="font-display text-sm font-semibold text-teal">HiTab TQA</div>
        </header>
        <div className="min-w-0 flex-1 space-y-8 p-4 md:p-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function PageHeading({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="label-mono">{eyebrow}</div>
        <h1 className="font-display text-xl font-bold tracking-tight md:text-2xl">{title}</h1>
      </div>
      {right}
    </div>
  );
}
