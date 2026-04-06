import type { ToolTraceEntry } from '../types';

const STATUS_STYLE: Record<ToolTraceEntry['status'], string> = {
  pending: 'bg-slate-100 text-slate-600',
  running: 'bg-sky-100 text-sky-700',
  needs_confirmation: 'bg-violet-100 text-violet-700',
  needs_disambiguation: 'bg-fuchsia-100 text-fuchsia-700',
  completed: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-rose-100 text-rose-700',
  cancelled: 'bg-amber-100 text-amber-700',
};

export function ToolTimeline({ traces }: { traces: ToolTraceEntry[] }) {
  if (traces.length === 0) return null;

  return (
    <ol className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-white/70 p-3">
      {traces.map((trace) => (
        <li key={trace.id} className="rounded-md border border-slate-100 bg-white p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">{trace.toolName}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[trace.status]}`}>{trace.status}</span>
          </div>
          <p className="mt-1 text-xs text-slate-600">{trace.detail}</p>
        </li>
      ))}
    </ol>
  );
}
