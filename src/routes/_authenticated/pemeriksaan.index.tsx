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
const GRID_COLS =
  "grid min-w-[56rem] grid-cols-[12rem_3.5rem_minmax(16rem,1fr)_9rem_10rem] items-center gap-3";
const STATUS_KEYS = ["semua", "belum_diperiksa", "sedang_diperiksa", "selesai"] as const;
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

  const statusCount = (key: ReviewFilter) =>
    key === "semua" ? counts?.total : key === "belum_diperiksa" ? counts?.belum : key === "sedang_diperiksa" ? counts?.sedang : counts?.selesai;

  return (
    <section>
      <PageHeading
        eyebrow="v · pemeriksaan validator"
        title="Daftar pemeriksaan"
        right={<span className="font-mono text-[11px] text-mist">{totalFiltered} entri</span>}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          placeholder={kind === "tabel" ? "Cari judul tabel atau kode…" : "Cari judul tabel atau teks pertanyaan…"}
          aria-label="Cari judul tabel atau teks pertanyaan"
          className="min-w-[14rem] flex-1 rounded-md bg-transparent px-3 py-1.5 text-sm ring-1 ring-line focus:outline-none focus:ring-ink/30"
        />
        <div role="tablist" aria-label="Jenis pemeriksaan" className="flex rounded-md p-0.5 ring-1 ring-line">
          {(["tabel", "pertanyaan"] as const).map((tab) => (
            <button key={tab} type="button" role="tab" aria-selected={kind === tab}
              onClick={() => setTab(tab)}
              className={`rounded px-3 py-1 text-sm transition-colors ${kind === tab ? "bg-ink/10 text-ink" : "text-mist hover:text-ink"}`}>
              {tab === "tabel" ? "Tabel" : "Pertanyaan"}
            </button>
          ))}
        </div>
      </div>

      <div aria-label="Filter status pemeriksaan" className="mb-3 flex flex-wrap gap-1 border-b border-line/70">
        {STATUS_KEYS.map((key) => {
          const active = status === key;
          return (
            <button key={key} type="button" aria-pressed={active}
              onClick={() => { setStatus(key); setPage(0); }}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${active ? "border-ink text-ink" : "border-transparent text-mist hover:text-ink"}`}>
              {filterNames[key]}
              <span className="ml-1.5 font-mono text-xs text-mist">{statusCount(key) ?? 0}</span>
            </button>
          );
        })}
      </div>

      {error && <p role="alert" className="mb-3 rounded-lg bg-amber/10 p-3 text-sm text-amber">Gagal memuat daftar: {error.message}. Pastikan migrasi validator sudah dijalankan.</p>}

      <div className="panel overflow-x-auto">
        <div className={`${GRID_COLS} border-b border-line/70 py-2 pr-4`}>
          <div className="label-mono sticky left-0 z-10 bg-frost py-1 pl-4">Kode</div>
          <div className="label-mono">No</div>
          <div className="label-mono">{kind === "tabel" ? "Judul tabel" : "Pertanyaan"}</div>
          <div className="label-mono">Status</div>
          <div className="label-mono">Aksi</div>
        </div>

        {isPending ? (
          <div className="px-4 py-8 text-center text-sm text-mist">Memuat daftar pemeriksaan…</div>
        ) : data?.rows.length ? data.rows.map((item, index) => {
          const claimedByOther = !!item.reviewer_id && item.reviewer_id !== userId && !isAdmin;
          const disabled = !item.is_ready || claimedByOther;
          const action = item.review_status === "selesai" ? "Perbaiki" : item.review_status === "sedang_diperiksa" ? "Lanjutkan" : "Mulai pemeriksaan";
          const reason = !item.is_ready ? "Terjemahan belum lengkap" : claimedByOther ? "Sedang ditangani validator lain" : "";
          return (
            <div key={item.item_id} className={`${GRID_COLS} border-b border-line/40 py-2.5 pr-4 text-sm transition-colors last:border-b-0 hover:bg-ink/5`}>
              <span className="sticky left-0 z-10 truncate bg-frost py-1 pl-4 font-mono text-xs text-cyan" title={item.table_code}>{item.table_code}</span>
              <span className="font-mono text-xs text-mist">{page * PAGE_SIZE + index + 1}</span>
              <span className="min-w-0">
                <span className="block truncate">{item.source_text}</span>
                <span className="block truncate text-xs text-mist">{item.translated_text || "Belum diterjemahkan"}</span>
              </span>
              <span className="flex items-center gap-1.5 text-xs">
                <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${item.review_status === "selesai" ? "bg-teal" : item.review_status === "sedang_diperiksa" ? "bg-amber" : "bg-mist/50"}`} />
                {filterNames[item.review_status as ReviewFilter] ?? item.review_status}
              </span>
              <span className="min-w-0">
                {disabled ? <button disabled title={reason} className="rounded-md px-2.5 py-1 text-xs opacity-45 ring-1 ring-line">{action}</button>
                  : <Link to="/pemeriksaan/$jenis/$id" params={{ jenis: kind, id: item.item_id }}
                    className="inline-block whitespace-nowrap rounded-md bg-teal px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-teal/90">{action}</Link>}
                {reason && <span className="mt-0.5 block truncate text-[11px] text-mist">{reason}</span>}
              </span>
            </div>
          );
        }) : <div className="px-4 py-8 text-center text-sm text-mist">Tidak ada entri yang cocok.</div>}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 font-mono text-xs text-mist">
        <span>{totalFiltered ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, totalFiltered)} dari ${totalFiltered}` : "0 entri"}</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={page === 0 || isPending} onClick={() => setPage((p) => p - 1)} className="rounded-md px-3 py-1.5 ring-1 ring-line hover:bg-ink/5 disabled:opacity-40">← Sebelumnya</button>
          <span>{page + 1} / {Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE))}</span>
          <button type="button" disabled={(page + 1) * PAGE_SIZE >= totalFiltered || isPending} onClick={() => setPage((p) => p + 1)} className="rounded-md px-3 py-1.5 ring-1 ring-line hover:bg-ink/5 disabled:opacity-40">Berikutnya →</button>
        </div>
      </div>
    </section>
  );
}
