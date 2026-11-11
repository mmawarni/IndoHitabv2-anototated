import { Link } from "@tanstack/react-router";

export function IncidentReportLink({ tableId }: { tableId: string }) {
  return (
    <Link
      to="/terjemahan/$tableId/insiden"
      params={{ tableId }}
      className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-amber ring-1 ring-amber/30 transition-colors hover:bg-amber/10"
    >
      Laporkan insiden
    </Link>
  );
}
