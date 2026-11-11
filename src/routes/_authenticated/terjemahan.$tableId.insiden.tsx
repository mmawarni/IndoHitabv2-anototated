import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeading } from "@/components/AppShell";
import { useCurrentUser } from "@/hooks/useAuth";

export const Route = createFileRoute(
  "/_authenticated/terjemahan/$tableId/insiden",
)({
  head: () => ({ meta: [{ title: "Laporkan Insiden — IndoHiTAB" }] }),
  component: IncidentReportPage,
});

type IncidentCategory =
  | "data_sumber"
  | "terjemahan"
  | "struktur_tabel"
  | "qa"
  | "aplikasi"
  | "lainnya";

function IncidentReportPage() {
  const { tableId } = Route.useParams();
  const navigate = useNavigate();
  const { userId, isAdmin, isAnotator, isValidator, rolesLoading, rolesError } =
    useCurrentUser();
  const allowed = isAdmin || isAnotator || isValidator;

  const [category, setCategory] = useState<IncidentCategory>("data_sumber");
  const [description, setDescription] = useState("");
  const [locationNote, setLocationNote] = useState("");

  const { data: table, isLoading, error } = useQuery({
    queryKey: ["incident-table", tableId],
    enabled: allowed,
    queryFn: async () => {
      const result = await supabase
        .from("tqa_tables")
        .select("id, code, title_en, batch_no, original_table_id")
        .eq("id", tableId)
        .maybeSingle();
      if (result.error) throw result.error;
      return result.data;
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Sesi pengguna tidak ditemukan.");
      const cleanDescription = description.trim();
      if (cleanDescription.length < 10) {
        throw new Error("Deskripsi insiden minimal 10 karakter.");
      }

      // Temporary cast allows compilation before Supabase generated types are refreshed.
      const db = supabase as any;
      const result = await db.from("incident_reports").insert({
        table_id: tableId,
        reporter_id: userId,
        category,
        description: cleanDescription,
        location_note: locationNote.trim() || null,
      });
      if (result.error) throw result.error;
    },
    onSuccess: () => {
      toast.success("Laporan insiden berhasil dikirim.");
      void navigate({ to: "/terjemahan/$tableId", params: { tableId } });
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : "Gagal mengirim laporan insiden.",
      );
    },
  });

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert">Gagal memuat peran.</p>;
  if (!allowed) return <p role="alert">Anda tidak memiliki akses.</p>;
  if (isLoading) return <p className="label-mono">Memuat tabel…</p>;
  if (error) return <p role="alert">Gagal memuat tabel: {error.message}</p>;
  if (!table) return <p role="alert">Tabel tidak ditemukan.</p>;

  return (
    <section className="max-w-3xl">
      <PageHeading
        eyebrow="laporan insiden"
        title={`Laporkan masalah · ${table.code}`}
        right={
          <Link
            to="/terjemahan/$tableId"
            params={{ tableId }}
            className="rounded-lg px-3 py-2 text-sm ring-1 ring-line hover:bg-ink/5"
          >
            Kembali ke terjemahan
          </Link>
        }
      />

      <div className="mb-4 rounded-lg bg-frost p-4 ring-1 ring-line">
        <div className="font-mono text-xs text-mist">
          Batch {table.batch_no ?? "—"} · {table.original_table_id ?? table.id}
        </div>
        <div className="mt-1 font-medium">{table.title_en}</div>
      </div>

      <form
        className="panel space-y-5 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit.mutate();
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium">Jenis insiden</label>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as IncidentCategory)}
            className="w-full rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line"
          >
            <option value="data_sumber">Masalah data sumber</option>
            <option value="terjemahan">Masalah terjemahan</option>
            <option value="struktur_tabel">Masalah struktur tabel</option>
            <option value="qa">Masalah pertanyaan / jawaban</option>
            <option value="aplikasi">Masalah aplikasi</option>
            <option value="lainnya">Lainnya</option>
          </select>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium">Lokasi masalah (opsional)</label>
          <input
            value={locationNote}
            onChange={(event) => setLocationNote(event.target.value)}
            placeholder="Contoh: body cell baris 4 kolom 2 / QA ke-3"
            className="w-full rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium">Deskripsi insiden</label>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={7}
            required
            minLength={10}
            placeholder="Jelaskan masalah yang ditemukan dan informasi yang diperlukan untuk memeriksanya."
            className="w-full rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-amber/40"
          />
          <p className="mt-2 text-xs text-mist">
            Laporan disimpan terpisah dan tidak mengubah terjemahan maupun hasil validasi.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={submit.isPending}
            className="rounded-lg bg-amber px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {submit.isPending ? "Mengirim…" : "Kirim laporan"}
          </button>
          <Link
            to="/terjemahan/$tableId"
            params={{ tableId }}
            className="rounded-lg px-4 py-2 text-sm ring-1 ring-line"
          >
            Batal
          </Link>
        </div>
      </form>
    </section>
  );
}
