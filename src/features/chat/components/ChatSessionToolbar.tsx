type ChatSessionToolbarProps = {
  disabled: boolean;
  onClearHistory: () => Promise<void>;
  onResetContext: () => Promise<void>;
  onExportJson: () => Promise<void>;
  onExportMarkdown: () => Promise<void>;
};

export function ChatSessionToolbar({
  disabled,
  onClearHistory,
  onResetContext,
  onExportJson,
  onExportMarkdown,
}: ChatSessionToolbarProps) {
  const baseClass = 'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Session</span>
        <button className={baseClass} disabled={disabled} onClick={onClearHistory} type="button">Clear history</button>
        <button className={baseClass} disabled={disabled} onClick={onResetContext} type="button">Reset context</button>
        <button className={baseClass} disabled={disabled} onClick={onExportJson} type="button">Export JSON</button>
        <button className={baseClass} disabled={disabled} onClick={onExportMarkdown} type="button">Export Markdown</button>
      </div>
    </div>
  );
}
