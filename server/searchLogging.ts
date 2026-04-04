import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export type SearchDiagnosticStatus = 'success' | 'error';

export type SearchDiagnostic = {
  timestamp: string;
  provider: string;
  mode: 'single' | 'deep';
  result_count: number;
  latency_ms: number;
  status: SearchDiagnosticStatus;
  error_code: string | null;
  query_fingerprint: string;
};

const MAX_RECENT_LOGS = 200;
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const LOG_PATH = path.resolve(process.cwd(), 'data/search-runtime.log');
const LOG_ROTATED_PATH = path.resolve(process.cwd(), 'data/search-runtime.log.1');

const recentDiagnostics: SearchDiagnostic[] = [];

const toErrorCode = (error: unknown): string => {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'aborted';
    return error.name ? error.name.toLowerCase() : 'error';
  }
  return 'error';
};

const rotateIfNeeded = () => {
  if (!existsSync(LOG_PATH)) return;
  const currentSize = statSync(LOG_PATH).size;
  if (currentSize < MAX_LOG_FILE_BYTES) return;
  if (existsSync(LOG_ROTATED_PATH)) rmSync(LOG_ROTATED_PATH);
  renameSync(LOG_PATH, LOG_ROTATED_PATH);
};

const rememberDiagnostic = (entry: SearchDiagnostic) => {
  recentDiagnostics.push(entry);
  if (recentDiagnostics.length > MAX_RECENT_LOGS) {
    recentDiagnostics.splice(0, recentDiagnostics.length - MAX_RECENT_LOGS);
  }
};

const persistDiagnostic = (entry: SearchDiagnostic) => {
  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  rotateIfNeeded();
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
};

export const hashQueryFingerprint = (query: string): string => createHash('sha256')
  .update(query.trim())
  .digest('hex');

export const appendSearchDiagnostic = (diagnostic: {
  provider: string;
  mode: 'single' | 'deep';
  resultCount: number;
  latencyMs: number;
  query: string;
  status?: SearchDiagnosticStatus;
  error?: unknown;
  timestamp?: string;
}) => {
  const status = diagnostic.status ?? (diagnostic.error ? 'error' : 'success');
  const entry: SearchDiagnostic = {
    timestamp: diagnostic.timestamp ?? new Date().toISOString(),
    provider: diagnostic.provider,
    mode: diagnostic.mode,
    result_count: Math.max(0, Math.floor(diagnostic.resultCount)),
    latency_ms: Math.max(0, Math.round(diagnostic.latencyMs)),
    status,
    error_code: status === 'error' ? toErrorCode(diagnostic.error) : null,
    query_fingerprint: hashQueryFingerprint(diagnostic.query),
  };

  rememberDiagnostic(entry);
  persistDiagnostic(entry);

  return entry;
};

export const getRecentSearchDiagnostics = (): SearchDiagnostic[] => [...recentDiagnostics];
