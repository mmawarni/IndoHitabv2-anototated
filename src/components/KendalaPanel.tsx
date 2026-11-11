import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/useAuth";

export const ISSUE_TYPES = [
  { value: "makna", label: "Terjemahan tidak sesuai makna" },
  { value: "istilah_tidak_konsisten", label: "Istilah tidak konsisten" },
  { value: "istilah_ambigu", label: "Istilah ambigu / perlu konfirmasi" },
  { value: "nama_diri", label: "Nama diri / istilah khusus" },
  { value: "struktur_header", label: "Struktur header" },
  { value: "body_cell", label: "Body cell belum diterjemahkan" },
  { value: "angka_simbol_satuan", label: "Angka / simbol / satuan" },
  { value: "pertanyaan", label: "Pertanyaan" },
  { value: "jawaban", label: "Jawaban" },
  { value: "ketidaksesuaian_qa", label: "Ketidaksesuaian pertanyaan–jawaban" },
  { value: "bahasa_typo", label: "Bahasa / typo" },
  { value: "data_sumber", label: "Masalah data sumber" },
  { value: "aplikasi", label: "Masalah aplikasi" },
  { value: "lainnya", label: "Lainnya" },
] as const;

const SEVERITIES = [
  { value: "minor", label: "Minor", className: "text-mist ring-line" },
  { value: "major", label: "Major", className: "bg-amber/10 text-amber ring-amber/30" },
  { value: "critical", label: "Critical", className: "bg-destructive/10 text-destructive ring-destructive/30" },
] as const;

type Severity = (typeof SEVERITIES)[number]["value"];
type ReporterRole = "anotator" | "validator" | "admin";

const issueLabel = (value: string) => ISSUE_TYPES.find((t) => t.value === value)?.label ?? value;
const roleLabel: Record<string, string> = { anotator: "Anotator", validator: "Validator", admin: "Admin" };

/**
 * "Laporan Kendala" for one table: a checklist form plus the read-only history of
 * every report filed for it by annotators and validators. Reports never change
 * translation or review completion.
 */
export function KendalaPanel({ tableId, reporterRole }: { tableId: string; reporterRole: ReporterRole }) {
  const { userId } = useCurrentUser();
  const queryClient = useQueryClient();
  const [issues, setIssues] = useState<string[]>([]);
  const [severity, setSeverity] = useState<Severity | "">("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [suggestion, setSuggestion] = useState("");

  const reports = useQuery({
    queryKey: ["kendala", tableId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("incident_reports")
        .select("id, reporter_id, reporter_role, issue_types, severity, description, location_note, suggestion, status, created_at")
        .eq("table_id", tableId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const ids = Array.from(new Set((data ?? []).map((r) => r.reporter_id)));
      const names = new Map<string, string>();
      if (ids.length) {
        const profiles = await supabase.from("profiles").select("id, full_name, email").in("id", ids);
        if (profiles.error) throw profiles.error;
        for (const p of profiles.data ?? []) names.set(p.id, p.full_name || p.email);
      }
      return (data ?? []).map((r) => ({ ...r, reporterName: names.get(r.reporter_id) ?? "Pengguna" }));
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Sesi pengguna tidak ditemukan.");
      if (!issues.length) throw new Error("Pilih minimal satu jenis masalah.");
      if (!severity) throw new Error("Pilih tingkat masalah.");
      if (description.trim().length < 10) throw new Error("Deskripsi kendala minimal 10 karakter.");
      const { error } = await supabase.from("incident_reports").insert({
        table_id: tableId,
        reporter_id: userId,
        reporter_role: reporterRole,
        issue_types: issues,
        severity,
        description: description.trim(),
        location_note: location.trim() || null,
        suggestion: suggestion.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Laporan kendala tersimpan.");
      setIssues([]);
      setSeverity("");
      setDescription("");
      setLocation("");
      setSuggestion("");
      queryClient.invalidateQueries({ queryKey: ["kendala", tableId] });
      queryClient.invalidateQueries({ queryKey: ["kendala-flags"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Gagal menyimpan laporan kendala."),
  });

  const toggleIssue = (value: string) =>
    setIssues((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  const fieldClass =
    "w-full rounded-lg bg-frost px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50";

  return (
    <div className="space-y-4">
      <form
        className="panel space-y-5 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate();
        }}
      >
        <fieldset>
          <legend className="label-mono mb-2">Jenis masalah</legend>
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {ISSUE_TYPES.map((type) => (
              <label key={type.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-ink/5">
                <input type="checkbox" checked={issues.includes(type.value)} onChange={() => toggleIssue(type.value)} />
                {type.label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="label-mono mb-2">Tingkat masalah</legend>
          <div className="flex flex-wrap gap-4">
            {SEVERITIES.map((s) => (
              <label key={s.value} className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="radio" name={`severity-${tableId}`} checked={severity === s.value} onChange={() => setSeverity(s.value)} />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor={`kendala-desc-${tableId}`} className="label-mono mb-1 block">Deskripsi kendala</label>
          <textarea id={`kendala-desc-${tableId}`} rows={3} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Jelaskan kendala yang ditemukan." className={fieldClass} />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor={`kendala-loc-${tableId}`} className="label-mono mb-1 block">Lokasi (opsional)</label>
            <input id={`kendala-loc-${tableId}`} value={location} onChange={(e) => setLocation(e.target.value)}
              placeholder="Contoh: header baris 2 / QA ke-3" className={fieldClass} />
          </div>
          <div>
            <label htmlFor={`kendala-sug-${tableId}`} className="label-mono mb-1 block">Usulan perbaikan (opsional)</label>
            <input id={`kendala-sug-${tableId}`} value={suggestion} onChange={(e) => setSuggestion(e.target.value)}
              placeholder="Usulan terjemahan atau tindakan" className={fieldClass} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={submit.isPending}
            className="rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-primary-foreground ring-1 ring-teal/40 transition-colors hover:bg-teal/90 disabled:opacity-60">
            {submit.isPending ? "Menyimpan…" : "Simpan laporan"}
          </button>
          <span className="text-xs text-mist">Laporan tidak mengubah status selesai terjemahan maupun validasi.</span>
        </div>
      </form>

      <div className="panel overflow-hidden">
        <div className="label-mono border-b border-line/70 px-4 py-2">
          Catatan tersimpan · {reports.data?.length ?? 0}
        </div>
        {reports.isPending ? (
          <p className="px-4 py-6 text-sm text-mist">Memuat catatan…</p>
        ) : reports.error ? (
          <p role="alert" className="px-4 py-6 text-sm text-amber">Gagal memuat catatan: {reports.error.message}</p>
        ) : !reports.data?.length ? (
          <p className="px-4 py-6 text-sm text-mist">Belum ada laporan kendala untuk tabel ini.</p>
        ) : (
          reports.data.map((r) => {
            const sev = SEVERITIES.find((s) => s.value === r.severity);
            return (
              <article key={r.id} className="space-y-2 border-b border-line/50 px-4 py-3 text-sm last:border-b-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-mist">
                  <span className="font-medium text-ink">{r.reporterName}</span>
                  {r.reporter_role && <span className="rounded-full px-2 py-0.5 font-mono text-[10px] ring-1 ring-line">{roleLabel[r.reporter_role] ?? r.reporter_role}</span>}
                  {sev && <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] ring-1 ${sev.className}`}>{sev.label}</span>}
                  <span className="ml-auto font-mono">{new Date(r.created_at).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}</span>
                </div>
                {r.issue_types.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {r.issue_types.map((t) => (
                      <span key={t} className="rounded-md bg-ink/5 px-2 py-0.5 text-xs">{issueLabel(t)}</span>
                    ))}
                  </div>
                )}
                <p className="whitespace-pre-wrap">{r.description}</p>
                {r.location_note && <p className="text-xs text-mist">Lokasi: {r.location_note}</p>}
                {r.suggestion && <p className="text-xs text-mist">Usulan: {r.suggestion}</p>}
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
