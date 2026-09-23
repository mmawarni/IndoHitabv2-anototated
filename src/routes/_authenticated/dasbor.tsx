import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeading } from "@/components/AppShell";
import { useCurrentUser } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/dasbor")({
  head: () => ({ meta: [{ title: "Dasbor Progres — IndoHiTAB" }] }),
  component: DashboardPage,
});

type SourceProgress = {
  data_source_id: number | null;
  data_source_code: string;
  data_source_name: string;
  tables_all: number;
  tables_current: number;
  tables_done: number;
  qa_all: number;
  qa_current: number;
  qa_done: number;
};

function Counts({ title, all, current, done, definition }: {
  title: string; all: number; current: number; done: number; definition: string;
}) {
  const percent = all ? Math.round((done / all) * 100) : 0;
  return <section className="panel p-5">
    <div className="label-mono">{title}</div>
    <div className="mt-4 grid grid-cols-3 gap-2 text-center">
      <div><div className="font-display text-2xl font-bold">{all}</div><div className="text-xs text-mist">Semua</div></div>
      <div><div className="font-display text-2xl font-bold text-amber">{current}</div><div className="text-xs text-mist">Belum selesai</div></div>
      <div><div className="font-display text-2xl font-bold text-teal">{done}</div><div className="text-xs text-mist">Selesai</div></div>
    </div>
    <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-line/60">
      <div className="h-full bg-teal" style={{ width: `${percent}%` }} />
    </div>
    <p className="mt-2 text-xs text-mist">{percent}% selesai · {definition}</p>
  </section>;
}

function DashboardPage() {
  const { userId, roles, isAdmin, isValidator, rolesLoading, rolesError } = useCurrentUser();
  const globalView = isAdmin || isValidator;
  const report = useQuery({
    queryKey: ["dashboard-breakdown-v8", userId, [...roles].sort().join(",")],
    enabled: !!userId && !rolesLoading && !rolesError,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("hitab_dashboard_breakdown_v8", {});
      if (error) throw error;
      return (data ?? []) as SourceProgress[];
    },
  });
  if (rolesLoading || report.isPending) return <p className="label-mono">Memuat statistik…</p>;
  if (rolesError) return <p role="alert">Gagal memuat peran pengguna.</p>;
  if (report.error) return <p role="alert">Gagal memuat statistik. Periksa migration v8: {report.error.message}</p>;
  const total = report.data?.find((row) => row.data_source_code === "all");
  if (!total) return <p role="status">Data belum tersedia.</p>;
  const groups = (report.data ?? []).filter((row) => row.data_source_code !== "all");
  const completedDefinition = globalView
    ? "Selesai = tervalidasi (QA juga memerlukan tabel induk final dan logika terkonfirmasi)."
    : "Selesai = terjemahan lengkap, bukan hasil pemeriksaan validator.";
  return <section className="mx-auto max-w-6xl">
    <PageHeading eyebrow="a · dasbor progres"
      title={globalView ? "Progres seluruh tim" : "Progres penugasan saya"}
      right={<span className="font-mono text-xs text-mist">Hanya sampel dengan annotate_flag = 1</span>} />
    <p className="mb-6 text-sm text-mist">
      {globalView ? "Admin dan Validator melihat semua pekerjaan dalam sampel, termasuk yang belum ditugaskan."
        : "Anotator melihat tabel dan QA yang ditugaskan kepada akun ini saja."}
      {" "}Belum selesai mencakup pekerjaan yang belum dimulai maupun sedang dikerjakan.
    </p>
    <div className="grid gap-4 md:grid-cols-2">
      <Counts title="Tabel" all={Number(total.tables_all)} current={Number(total.tables_current)}
        done={Number(total.tables_done)} definition={completedDefinition} />
      <Counts title="Pertanyaan & jawaban (QA)" all={Number(total.qa_all)} current={Number(total.qa_current)}
        done={Number(total.qa_done)} definition={completedDefinition} />
    </div>
    <section className="mt-8 panel overflow-hidden">
      <div className="border-b border-line/60 p-5">
        <h2 className="font-display text-lg font-semibold">Progres menurut data source</h2>
        <p className="mt-1 text-sm text-mist">Kode data source adalah klasifikasi database; ID 1 = NSC. Sumber yang belum dapat ditentukan tetap terpisah.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[740px] text-left text-sm">
          <thead className="bg-frost text-xs text-mist">
            <tr>
              <th className="p-3">Sumber</th><th className="p-3 text-right">Tabel semua</th>
              <th className="p-3 text-right">Tabel belum selesai</th><th className="p-3 text-right">Tabel selesai</th>
              <th className="p-3 text-right">QA semua</th><th className="p-3 text-right">QA belum selesai</th>
              <th className="p-3 text-right">QA selesai</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => <tr key={group.data_source_code} className="border-t border-line/50">
              <th scope="row" className="p-3 font-medium">{group.data_source_name} <span className="font-mono text-xs text-mist">({group.data_source_code})</span></th>
              <td className="p-3 text-right font-mono">{group.tables_all}</td>
              <td className="p-3 text-right font-mono">{group.tables_current}</td>
              <td className="p-3 text-right font-mono">{group.tables_done}</td>
              <td className="p-3 text-right font-mono">{group.qa_all}</td>
              <td className="p-3 text-right font-mono">{group.qa_current}</td>
              <td className="p-3 text-right font-mono">{group.qa_done}</td>
            </tr>)}
            {!groups.length && <tr><td colSpan={7} className="p-5 text-center text-mist">Belum ada data sumber dalam cakupan akun ini.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
    <p className="mt-3 text-xs text-mist">{completedDefinition} Angka QA dan tabel dihitung terpisah; QA dapat termasuk sampel meski tabel induknya tidak.</p>
  </section>;
}
