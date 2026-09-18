import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useAuth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const [signUpOpen, setSignUpOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [signUpEmail, setSignUpEmail] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");
  const [signUpBusy, setSignUpBusy] = useState(false);

  useEffect(() => {
    if (!loading && session) navigate({ to: "/dasbor", replace: true });
  }, [loading, session, navigate]);

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      navigate({ to: "/dasbor", replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Terjadi kesalahan.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSignUp(event: React.FormEvent) {
    event.preventDefault();
    setSignUpBusy(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: signUpEmail,
        password: signUpPassword,
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
        setSignUpOpen(false);
        setFullName("");
        setSignUpEmail("");
        setSignUpPassword("");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Terjadi kesalahan.");
    } finally {
      setSignUpBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-paper px-6 py-14">
      <div className="relative w-full max-w-[26rem]">
        <div className="prism prism-animate absolute -inset-4 rounded-[28px] opacity-70 blur-xl" />
        <form onSubmit={handleLogin} className="panel rise relative rounded-[20px] p-8">
          <div className="mb-6 flex items-center gap-2">
            <span className="font-display grid size-7 place-items-center rounded-lg bg-teal/15 text-sm font-bold text-teal ring-1 ring-teal/30">
              H
            </span>
            <div>
              <div className="font-display text-sm leading-none font-semibold">HiTab TQA</div>
              <div className="label-mono mt-1">Panel anotasi</div>
            </div>
          </div>

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
            autoComplete="current-password"
            className="mb-6 w-full rounded-xl bg-paper/80 px-3 py-2 font-mono text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
            placeholder="••••••••••"
          />

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-teal py-2.5 text-sm font-semibold text-primary-foreground ring-1 ring-teal/40 transition-colors hover:bg-teal/90 disabled:opacity-60"
          >
            {busy ? "Memproses…" : "Masuk ke ruang kerja"}
          </button>

          <button
            type="button"
            onClick={() => setSignUpOpen(true)}
            className="mt-3 w-full rounded-xl bg-teal/10 py-2.5 text-sm font-semibold text-teal ring-1 ring-teal/40 transition-colors hover:bg-teal/20"
          >
            Belum punya akun? Daftar sekarang
          </button>

          <div className="mt-5 flex items-center justify-center border-t border-line/70 pt-4 font-mono text-[10px] text-mist">
            <span>Sesi aman</span>
          </div>
        </form>
      </div>

      <Dialog open={signUpOpen} onOpenChange={setSignUpOpen}>
        <DialogContent className="rounded-[20px] sm:max-w-[24rem]">
          <DialogHeader>
            <DialogTitle className="font-display">Buat akun baru</DialogTitle>
            <DialogDescription>
              Daftar untuk bergabung ke panel anotasi HiTab TQA. Admin akan menetapkan peran
              Anotator atau Validator setelah akun dikonfirmasi.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSignUp}>
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

            <label className="mb-1.5 block font-mono text-[11px] tracking-wide text-mist">
              Email kerja
            </label>
            <input
              type="email"
              value={signUpEmail}
              onChange={(e) => setSignUpEmail(e.target.value)}
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
              value={signUpPassword}
              onChange={(e) => setSignUpPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
              className="mb-6 w-full rounded-xl bg-paper/80 px-3 py-2 font-mono text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50"
              placeholder="••••••••••"
            />

            <button
              type="submit"
              disabled={signUpBusy}
              className="w-full rounded-xl bg-teal py-2.5 text-sm font-semibold text-primary-foreground ring-1 ring-teal/40 transition-colors hover:bg-teal/90 disabled:opacity-60"
            >
              {signUpBusy ? "Memproses…" : "Buat akun"}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
