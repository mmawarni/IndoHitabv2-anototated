import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeading } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated/dasbor")({
  head: () => ({ meta: [{ title: "Dasbor Progres — HiTAB TQA" }] }),
  component: DashboardPage,
});

function percent(done: number, total: number) { return total ? Math.round((done/total)*100) : 0; }
function StatCard({label,done,total,bar}:{label:string;done:number;total:number;bar:string}) {
  return <div className="panel p-4">
    <div className="font-mono text-[11px] text-mist">{label}</div>
    <div className="font-display mt-2 text-2xl font-bold">{percent(done,total)}%</div>
    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line/60">
      <div className={`h-full ${bar}`} style={{width:`${percent(done,total)}%`}} />
    </div>
    <div className="mt-2 font-mono text-[10px] text-mist">{done} dari {total} selesai</div>
  </div>;
}
function DashboardPage() {
  const {data,isPending,error}=useQuery({
    queryKey:["progres"],
    queryFn:async()=>{
      const [progress,people]=await Promise.all([
        supabase.rpc("hitab_progress",{}),supabase.rpc("hitab_user_contributions",{}),
      ]);
      if (progress.error) throw progress.error;
      if (people.error) throw people.error;
      return {counts:progress.data?.[0] ?? null,people:people.data ?? []};
    },
  });
  if (isPending) return <p className="label-mono">Memuat progres…</p>;
  if (error || !data?.counts) return <p role="alert">Gagal memuat progres. Pastikan migration v3 sudah diterapkan.</p>;
  const counts=data.counts;
  const maximum=Math.max(1,...data.people.map((p)=>Number(p.entry_count)));
  return <section>
    <PageHeading eyebrow="a · dasbor progres" title="Rekap anotator"
      right={<span className="font-mono text-xs text-mist">{counts.tables_total} tabel · {counts.cells_total} sel · {counts.qa_total} QA dalam sampel</span>} />
    <div className="grid gap-4 md:grid-cols-3">
      <StatCard label="Header dan label diterjemahkan" done={counts.cells_done} total={counts.cells_total} bar="bg-teal" />
      <StatCard label="Pasangan QA" done={counts.qa_done} total={counts.qa_total} bar="bg-cyan" />
      <StatCard label="Judul tabel" done={counts.titles_done} total={counts.tables_total} bar="bg-amber" />
    </div>
    <div className="mt-8">
      <div className="label-mono mb-3">Kontribusi per anotator (status terakhir)</div>
      <div className="panel overflow-hidden">
        {data.people.length ? data.people.map((p)=><div key={p.user_id}
          className="grid grid-cols-[1fr_10rem_4rem] items-center gap-3 border-b border-line/50 px-4 py-3 text-sm last:border-b-0">
          <span className="font-medium">{p.full_name || p.email || p.user_id}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-line/60">
            <div className="h-full rounded-full bg-teal" style={{width:`${percent(Number(p.entry_count),maximum)}%`}} />
          </div>
          <span className="text-right font-mono text-xs">{p.entry_count}</span>
        </div>) : <p className="p-4 text-sm text-mist">Belum ada terjemahan tersimpan.</p>}
      </div>
      <p className="mt-2 text-xs text-mist">Angka di atas menghitung data dengan flag sampel 1. Riwayat setiap penyimpanan tersedia di Pengguna → Log aktivitas.</p>
    </div>
  </section>;
}
