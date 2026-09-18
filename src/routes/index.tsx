import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useAuth";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Masuk — Panel Anotasi HiTab TQA" },
      {
        name: "description",
        content:
          "Masuk ke ruang kerja anotator penerjemahan dataset HiTab TQA untuk mengerjakan header tabel, kolom, dan pasangan tanya-jawab.",
      },
      { property: "og:title", content: "Masuk — Panel Anotasi HiTab TQA" },
      {
        property: "og:description",
        content: "Ruang kerja anotator penerjemahan dataset HiTab TQA.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { session, loading } = useSession();
  const [mode, setMode] = useState<"masuk" | "daftar">("masuk");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && session) navigate({ to: "/dasbor", replace: true });
  }, [loading, session, navigate]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (mode === "masuk") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/dasbor", replace: true });
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
            data: { full_name: fullName },
          },
        });
        if (error) throw error;
        if (data.session) {
          navigate({ to: "/dasbor", replace: true });
        } else {
          toast.success("Akun dibuat. Setelah konfirmasi email, Admin akan menetapkan peran Anotator atau Validator.");
          setMode("masuk");
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Terjadi kesalahan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-paper px-6 py-14">
      <div className="relative w-full max-w-[26rem]">
        <div className="prism prism-animate absolute -inset-4 rounded-[28px] opacity-70 blur-xl" />
        <form
          onSubmit={handleSubmit}
          className="panel rise relative rounded-[20px] p-8"
        >
          <div className="mb-6 flex items-center gap-2">
            <span className="font-display grid size-7 place-items-center rounded-lg bg-teal/15 text-sm font-bold text-teal ring-1 ring-teal/30">
              H
            </span>
            <div>
              <div className="font-display text-sm leading-none font-semibold">HiTab TQA</div>
              <div className="label-mono mt-1">Panel anotasi</div>
            </div>
          </div>

          {mode === "daftar" && (
            <>
              <label className="mb-1.5 block font-mono text-[11px] tracking-wide text-mist">
                Nama lengkap
              </label>
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="mb-4 w-full rounded-xl bg-paper/80 px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
                placeholder="Rina Santoso"
              />
            </>
          )}

          <label className="mb-1.5 block font-mono text-[11px] tracking-wide text-mist">
            Email kerja
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            className="mb-4 w-full rounded-xl bg-paper/80 px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
            placeholder="nama@lab.id"
          />

          <label className="mb-1.5 block font-mono text-[11px] tracking-wide text-mist">
            Kata sandi
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            autoComplete={mode === "masuk" ? "current-password" : "new-password"}
            className="mb-6 w-full rounded-xl bg-paper/80 px-3 py-2 font-mono text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
            placeholder="••••••••••"
          />

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-teal py-2.5 text-sm font-semibold text-primary-foreground ring-1 ring-teal/40 transition-colors hover:bg-teal/90 disabled:opacity-60"
          >
            {busy
              ? "Memproses…"
              : mode === "masuk"
                ? "Masuk ke ruang kerja"
                : "Buat akun"}
          </button>

          <div className="mt-5 flex items-center justify-between border-t border-line/70 pt-4 font-mono text-[10px] text-mist">
            <button
              type="button"
              onClick={() => setMode(mode === "masuk" ? "daftar" : "masuk")}
              className="text-teal hover:underline"
            >
              {mode === "masuk" ? "Belum punya akun? Daftar" : "Sudah punya akun? Masuk"}
            </button>
            <span>Sesi aman</span>
          </div>
        </form>
      </div>
    </div>
  );
}
