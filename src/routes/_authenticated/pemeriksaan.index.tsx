import { createFileRoute, Link } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeading } from "@/components/AppShell";
import { useCurrentUser } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/pemeriksaan/")({
  head: () => ({ meta: [{ title: "Daftar Pemeriksaan — HiTab TQA" }] }),
  component: ReviewList,
});

type Kind = "tabel" | "pertanyaan";
type ReviewFilter = "semua" | "belum_diperiksa" | "sedang_diperiksa" | "selesai";
const PAGE_SIZE = 20;
const filterNames: Record<ReviewFilter, string> = {
  semua: "Semua",
  belum_diperiksa: "Belum diperiksa",
  sedang_diperiksa: "Sedang diperiksa",
  selesai: "Selesai",
};

function ReviewList() {
  const { userId, isAdmin, isValidator, rolesLoading, rolesError } = useCurrentUser();
  const allowed = isAdmin || isValidator;
  const [kind, setKind] = useState<Kind>("tabel");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [status, setStatus] = useState<ReviewFilter>("semua");
  const [page, setPage] = useState(0);

  const { data, isPending, error } = useQuery({
    queryKey: ["review-queue", kind, deferredSearch, status, page],
    enabled: allowed,
    queryFn: async () => {
      const [items, counts] = await Promise.all([
        supabase.rpc("review_queue", {
          _kind: kind, _search: deferredSearch, _status: status,
          _limit: PAGE_SIZE, _offset: page * PAGE_SIZE,
        }),
        supabase.rpc("review_queue_counts", { _kind: kind, _search: deferredSearch }),
      ]);
      if (items.error) throw items.error;
      if (counts.error) throw counts.error;
      return { rows: items.data ?? [], counts: counts.data?.[0] ?? { total: 0, belum: 0, sedang: 0, selesai: 0 } };
    },
  });

  if (rolesLoading) return <p className="label-mono">Memuat peran…</p>;
  if (rolesError) return <p role="alert" className="text-sm text-amber">Gagal memuat peran. Muat ulang halaman.</p>;
  if (!allowed) return <p role="alert" className="text-sm text-mist">Halaman ini hanya untuk Validator atau Admin.</p>;

  const counts = data?.counts;
  const totalFiltered = status === "semua" ? counts?.total ?? 0
    : status === "belum_diperiksa" ? counts?.belum ?? 0
    : status === "sedang_diperiksa" ? counts?.sedang ?? 0 : counts?.selesai ?? 0;
  const setTab = (next: Kind) => { setKind(next); setPage(0); setStatus("semua"); setSearch(""); };

  return (
    <section className="mx-auto max-w-6xl">
      <PageHeading
        eyebrow="v · pemeriksaan validator"
        title="Daftar pemeriksaan"
        right={<span className="font-mono text-xs text-mist">{totalFiltered} entri</span>}
      />
      <p className="mb-7 max-w-2xl text-sm leading-relaxed text-mist">
        Daftar tabel dan pertanyaan yang perlu diperiksa. Entri yang belum selesai diterjemahkan
        belum dapat dibuka untuk pemeriksaan.
      </p>
      <div role="tablist" aria-label="Jenis pemeriksaan" className="mb-5 flex border-b border-line/70">
        {(["tabel", "pertanyaan"] as const).map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={kind === tab}
            onClick={() => setTab(tab)}
            className={`border-b-2 px-6 py-3 font-mono text-sm capitalize transition-colors ${kind === tab ? "border-teal text-teal" : "border-transparent text-mist hover:text-ink"}`}>
            {tab === "tabel" ? "Tabel" : "Pertanyaan"}
          </button>
        ))}
      </div>
      <label className="mb-4 block">
        <span className="sr-only">Cari judul tabel atau teks pertanyaan</span>
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          placeholder={kind === "tabel" ? "Cari berdasarkan judul tabel atau kode…" : "Cari judul tabel atau teks pertanyaan…"}
          className="w-full rounded-xl bg-frost px-4 py-3 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-teal/50" />
      </label>
      <div aria-label="Filter status pemeriksaan" className="mb-5 flex flex-wrap gap-2">
        {(["semua", "belum_diperiksa", "sedang_diperiksa", "selesai"] as const).map((key) => {
          const count = key === "semua" ? counts?.total : key === "belum_diperiksa" ? counts?.belum : key === "sedang_diperiksa" ? counts?.sedang : counts?.selesai;
          return (
            <button key={key} type="button" aria-pressed={status === key}
              onClick={() => { setStatus(key); setPage(0); }}
              className={`rounded-full px-4 py-2 font-mono text-xs ring-1 transition-colors ${status === key ? "bg-teal/15 text-teal ring-teal/30" : "bg-transparent text-mist ring-line hover:bg-frost"}`}>
              {filterNames[key]} ({count ?? 0})
            </button>
          );
        })}
      </div>
      {error && <p role="alert" className="mb-4 rounded-lg bg-amber/10 p-3 text-sm text-amber">Gagal memuat daftar: {error.message}. Pastikan migrasi validator sudah dijalankan.</p>}
      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="border-b border-line/70 bg-frost/50">
            <tr className="label-mono">
              <th scope="col" className="px-4 py-3">No</th>
              <th scope="col" className="px-4 py-3">Kode</th>
              <th scope="col" className="px-4 py-3">{kind === "tabel" ? "Judul tabel" : "Pertanyaan"}</th>
              <th scope="col" className="px-4 py-3">Status</th>
              <th scope="col" className="px-4 py-3">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {isPending ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-mist">Memuat daftar pemeriksaan…</td></tr>
            ) : data?.rows.length ? data.rows.map((item, index) => {
              const claimedByOther = !!item.reviewer_id && item.reviewer_id !== userId && !isAdmin;
              const disabled = !item.is_ready || claimedByOther;
              const action = item.review_status === "selesai" ? "Perbaiki" : item.review_status === "sedang_diperiksa" ? "Lanjutkan" : "Mulai pemeriksaan";
              const reason = !item.is_ready ? "Terjemahan belum lengkap" : claimedByOther ? "Sedang ditangani validator lain" : "";
              return (
                <tr key={item.item_id} className="border-b border-line/50 last:border-b-0">
                  <td className="px-4 py-4 font-mono text-xs text-mist">{page * PAGE_SIZE + index + 1}</td>
                  <td className="px-4 py-4 font-mono text-xs text-cyan">{item.table_code}</td>
                  <td className="max-w-[25rem] px-4 py-4">
                    <div className="line-clamp-2 font-medium">{item.source_text}</div>
                    <div className="mt-1 line-clamp-2 text-xs text-mist">{item.translated_text || "Belum diterjemahkan"}</div>
                  </td>
                  <td className="px-4 py-4">
                    <span className={`whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-[11px] ring-1 ${item.review_status === "selesai" ? "bg-teal/10 text-teal ring-teal/25" : "text-mist ring-line"}`}>
                      {filterNames[item.review_status as ReviewFilter] ?? item.review_status}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    {disabled ? <button disabled title={reason} className="rounded-lg px-3 py-2 text-xs opacity-45 ring-1 ring-line">{action}</button>
                      : <Link to="/pemeriksaan/$jenis/$id" params={{ jenis: kind, id: item.item_id }}
                        className="inline-block whitespace-nowrap rounded-lg bg-teal px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-teal/90">{action}</Link>}
                    {reason && <div className="mt-1 text-[11px] text-mist">{reason}</div>}
                  </td>
                </tr>
              );
            }) : <tr><td colSpan={5} className="px-4 py-8 text-center text-mist">Tidak ada entri yang cocok.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 font-mono text-xs text-mist">
        <span>{totalFiltered ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, totalFiltered)} dari ${totalFiltered}` : "0 entri"}</span>
        <div className="flex gap-2">
          <button type="button" disabled={page === 0 || isPending} onClick={() => setPage((p) => p - 1)} className="rounded-lg px-3 py-2 ring-1 ring-line disabled:opacity-40">← Sebelumnya</button>
          <button type="button" disabled={(page + 1) * PAGE_SIZE >= totalFiltered || isPending} onClick={() => setPage((p) => p + 1)} className="rounded-lg px-3 py-2 ring-1 ring-line disabled:opacity-40">Berikutnya →</button>
        </div>
      </div>
    </section>
  );
}
