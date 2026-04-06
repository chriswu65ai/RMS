import { useCallback, useEffect, useMemo, useState } from 'react';
import { clearSystemLog, listSystemLog } from '../../lib/dataApi';

type SystemLogEntry = {
  timestamp: string;
  level: string;
  message: string;
  area?: string;
};

const PAGE_SIZE = 50;

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
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [level, setLevel] = useState('');
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const loadLogs = useCallback(async (mode: 'replace' | 'append' = 'replace') => {
    setLoading(true);
    setError(null);
    try {
      const payload = await listSystemLog({
        level: level || undefined,
        q: query || undefined,
        from: from || undefined,
        to: to || undefined,
        limit: PAGE_SIZE,
        cursor: mode === 'append' ? cursor : undefined,
      });
      setEntries((prev) => (mode === 'append' ? [...prev, ...payload.entries] : payload.entries));
      setCursor(payload.page?.next_cursor ?? null);
      setHasMore(Boolean(payload.page?.has_more));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load system log.');
    } finally {
      setLoading(false);
    }
  }, [cursor, from, level, query, to]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs, level, query, from, to]);

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

  const downloadVisibleLogs = useCallback(() => {
    const text = renderedLogLines.join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `system-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    anchor.click();
    URL.revokeObjectURL(href);
  }, [renderedLogLines]);

  const clearLogs = useCallback(async () => {
    setClearing(true);
    setError(null);
    try {
      await clearSystemLog();
      await loadLogs('replace');
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
          <select
            className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
            aria-label="Filter by level"
          >
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
            <option value="fatal">Fatal</option>
          </select>
          <input
            className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
            type="text"
            value={query}
            placeholder="Search logs"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter by text"
          />
          <input
            className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
            type="text"
            value={from}
            placeholder="From ISO time"
            onChange={(event) => setFrom(event.target.value)}
            aria-label="From date"
          />
          <input
            className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
            type="text"
            value={to}
            placeholder="To ISO time"
            onChange={(event) => setTo(event.target.value)}
            aria-label="To date"
          />
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
            onClick={downloadVisibleLogs}
            disabled={loading || renderedLogLines.length === 0}
          >
            Download
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
          <div className="space-y-3">
            <div className="max-h-[460px] overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-3">
              <pre className="font-mono text-xs leading-5 text-slate-100">
                {renderedLogLines.join('\n')}
              </pre>
            </div>
            {hasMore ? (
              <button
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                onClick={() => void loadLogs('append')}
                disabled={loading}
              >
                {loading ? 'Loading…' : 'Load older'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
