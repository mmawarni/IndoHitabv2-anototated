import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeading } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated/dasbor")({
  head: () => ({
    meta: [
      { title: "Dasbor Progres — HiTab TQA" },
      {
        name: "description",
        content:
          "Rekap progres penerjemahan dataset HiTab TQA: sel header, kolom, pasangan tanya-jawab, dan kontribusi tiap anotator.",
      },
      { property: "og:title", content: "Dasbor Progres — HiTab TQA" },
      {
        property: "og:description",
        content: "Rekap progres penerjemahan dataset HiTab TQA per anotator.",
      },
    ],
  }),
  component: DashboardPage,
});

function percent(done: number, total: number) {
  if (!total) return 0;
  return Math.round((done / total) * 100);
}

function useProgress() {
  return useQuery({
    queryKey: ["progres"],
    queryFn: async () => {
      const [cells, qa, tables, profiles] = await Promise.all([
        supabase.from("table_cells").select("id, target_text, updated_by"),
        supabase.from("qa_pairs").select("id, question_id, answer_id, updated_by"),
        supabase.from("tqa_tables").select("id, code, title_en, title_id"),
        supabase.from("profiles").select("id, full_name, email"),
      ]);
      if (cells.error) throw cells.error;
      if (qa.error) throw qa.error;
      if (tables.error) throw tables.error;
      if (profiles.error) throw profiles.error;
      return {
        cells: cells.data ?? [],
        qa: qa.data ?? [],
        tables: tables.data ?? [],
        profiles: profiles.data ?? [],
      };
    },
  });
}

function StatCard({
  label,
  value,
  total,
  bar,
}: {
  label: string;
  value: number;
  total: number;
  bar: string;
}) {
  const pct = percent(value, total);
  return (
    <div className="panel rise relative overflow-hidden p-4">
      <div className="prism absolute inset-0 opacity-60" />
      <div className="relative">
        <div className="font-mono text-[11px] text-mist">{label}</div>
        <div className="font-display mt-1 text-2xl font-bold">
          {pct}
          <span className="text-sm text-mist">%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line/60">
          <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 font-mono text-[10px] text-mist">
          {value} dari {total} selesai
        </div>
      </div>
    </div>
  );
}

function DashboardPage() {
  const { data, isLoading } = useProgress();

  if (isLoading || !data) {
    return <span className="label-mono">Memuat progres…</span>;
  }

  const cellsDone = data.cells.filter((c) => (c.target_text ?? "").trim().length > 0).length;
  const qaDone = data.qa.filter(
    (q) => (q.question_id ?? "").trim().length > 0 && (q.answer_id ?? "").trim().length > 0,
  ).length;
  const titlesDone = data.tables.filter((t) => (t.title_id ?? "").trim().length > 0).length;

  const nameOf = (id: string | null) => {
    if (!id) return null;
    const p = data.profiles.find((row) => row.id === id);
    return p?.full_name || p?.email || "Pengguna";
  };

  const contributions = new Map<string, number>();
  for (const cell of data.cells) {
    if ((cell.target_text ?? "").trim() && cell.updated_by) {
      const name = nameOf(cell.updated_by)!;
      contributions.set(name, (contributions.get(name) ?? 0) + 1);
    }
  }
  for (const pair of data.qa) {
    if ((pair.question_id ?? "").trim() && pair.updated_by) {
      const name = nameOf(pair.updated_by)!;
      contributions.set(name, (contributions.get(name) ?? 0) + 1);
    }
  }
  const maxContribution = Math.max(1, ...contributions.values());

  return (
    <section>
      <PageHeading
        eyebrow="a · dasbor progres"
        title="Rekap anotator"
        right={
          <div className="font-mono text-[11px] text-mist">
            {data.tables.length} tabel · {data.cells.length} sel · {data.qa.length} pasangan QA
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Header & kolom diterjemahkan"
          value={cellsDone}
          total={data.cells.length}
          bar="bg-teal"
        />
        <StatCard
          label="Pasangan tanya-jawab"
          value={qaDone}
          total={data.qa.length}
          bar="bg-cyan"
        />
        <StatCard
          label="Judul tabel"
          value={titlesDone}
          total={data.tables.length}
          bar="bg-amber"
        />
      </div>

      <div className="mt-8">
        <div className="label-mono mb-3">Kontribusi per anotator</div>
        <div className="panel overflow-hidden">
          {contributions.size === 0 ? (
            <div className="px-4 py-6 text-sm text-mist">
              Belum ada terjemahan tersimpan. Mulai dari ruang kerja.
            </div>
          ) : (
            [...contributions.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => (
                <div
                  key={name}
                  className="grid grid-cols-[1fr_10rem_4rem] items-center gap-3 border-b border-line/50 px-4 py-2.5 text-sm last:border-b-0"
                >
                  <span className="font-medium">{name}</span>
                  <div className="h-1.5 overflow-hidden rounded-full bg-line/60">
                    <div
                      className="h-full rounded-full bg-teal"
                      style={{ width: `${percent(count, maxContribution)}%` }}
                    />
                  </div>
                  <span className="text-right font-mono text-xs">{count} entri</span>
                </div>
              ))
          )}
        </div>
      </div>
    </section>
  );
}
