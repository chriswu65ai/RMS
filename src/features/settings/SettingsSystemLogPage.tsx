import { useCallback, useEffect, useMemo, useState } from 'react';
import { clearSystemLog, listSystemLog } from '../../lib/dataApi';

type SystemLogEntry = {
  timestamp: string;
  level: string;
  message: string;
  area?: string;
};

const DEFAULT_LOG_LIMIT = 200;

const formatLogLine = (entry: SystemLogEntry): string => {
  const normalizedTimestamp = entry.timestamp?.trim() || 'unknown-time';
  const normalizedLevel = (entry.level?.trim() || 'info').toUpperCase();
  const normalizedArea = entry.area?.trim() ? ` [${entry.area.trim()}]` : '';
  const normalizedMessage = entry.message?.trim() || '';
  return `${normalizedTimestamp} ${normalizedLevel}${normalizedArea} ${normalizedMessage}`.trim();
};

export function SettingsSystemLogPage() {
  const [entries, setEntries] = useState<SystemLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [clearing, setClearing] = useState(false);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextEntries = await listSystemLog(DEFAULT_LOG_LIMIT);
      setEntries(nextEntries);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load system log.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const renderedLogLines = useMemo(() => entries.map(formatLogLine), [entries]);

  const copyVisibleLogs = useCallback(async () => {
    const text = renderedLogLines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
      window.setTimeout(() => setCopyStatus('idle'), 1800);
    } catch {
      setCopyStatus('error');
      window.setTimeout(() => setCopyStatus('idle'), 2200);
    }
  }, [renderedLogLines]);

  const clearLogs = useCallback(async () => {
    setClearing(true);
    setError(null);
    try {
      await clearSystemLog();
      await loadLogs();
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Failed to clear system log.');
    } finally {
      setClearing(false);
    }
  }, [loadLogs]);

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">System Log</h2>
      <p className="text-sm text-slate-600">Backend errors and diagnostics for debugging.</p>
      <div className="w-full rounded-xl border border-slate-200 bg-white p-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            onClick={() => void loadLogs()}
            disabled={loading || clearing}
          >
            Refresh
          </button>
          <button
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            onClick={() => void copyVisibleLogs()}
            disabled={loading || renderedLogLines.length === 0}
          >
            Copy
          </button>
          <button
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            onClick={() => void clearLogs()}
            disabled={loading || clearing}
          >
            {clearing ? 'Clearing…' : 'Clear'}
          </button>
          {copyStatus === 'copied' ? <span className="text-sm text-emerald-700">Copied logs to clipboard.</span> : null}
          {copyStatus === 'error' ? <span className="text-sm text-rose-600">Clipboard access failed.</span> : null}
        </div>

        {loading ? <p className="text-sm text-slate-500">Loading system log…</p> : null}
        {!loading && error ? <p className="text-sm text-rose-600">{error}</p> : null}
        {!loading && !error && entries.length === 0 ? <p className="text-sm text-slate-500">No system log entries yet.</p> : null}
        {!loading && !error && entries.length > 0 ? (
          <div className="max-h-[460px] overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-3">
            <pre className="font-mono text-xs leading-5 text-slate-100">
              {renderedLogLines.join('\n')}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
