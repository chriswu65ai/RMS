import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export type SystemLogLevel = 'info' | 'warn' | 'error' | 'fatal';

export type SystemLogEntry = {
  timestamp: string;
  level: SystemLogLevel;
  area: string;
  message: string;
  details?: unknown;
  request_id?: string;
};

const MAX_RECENT_ENTRIES = 200;
const MAX_LOG_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LOG_DISK_BYTES = 64 * 1024 * 1024;
const MAX_ROTATED_FILES = 7;
const MAX_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOG_PATH = path.resolve(process.cwd(), 'data/system.log');
const COMPRESS_ROTATED_LOGS = (process.env.SYSTEM_LOG_COMPRESS_ROTATED ?? '1') !== '0';

const recentEntries: SystemLogEntry[] = [];

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|secret|token|password|authorization|auth|bearer)/i;
const SENSITIVE_VALUE_PATTERN = /((?:api[_-]?key|secret|token|password)\s*[:=]\s*)(['"]?)[^\s'",}]+/gi;
const REDACTED_VALUE = '[REDACTED]';
const STACK_LINE_SECRET_PATTERN = /(authorization|cookie|token|secret|api[_-]?key|password)\s*[:=]\s*([^\s]+)/gi;

const redactString = (value: string): string => value.replace(SENSITIVE_VALUE_PATTERN, `$1$2${REDACTED_VALUE}`);

const redactSensitive = (value: unknown): unknown => {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, entryValue]) => (
        SENSITIVE_KEY_PATTERN.test(key)
          ? [key, REDACTED_VALUE]
          : [key, redactSensitive(entryValue)]
      )),
    );
  }
  return value;
};

const sanitizeLogDetails = (details: unknown): unknown => {
  const redacted = redactSensitive(details);
  if (!redacted || typeof redacted !== 'object') return redacted;
  const record = redacted as Record<string, unknown>;
  const stack = typeof record.stack === 'string' ? record.stack : '';
  if (!stack) return redacted;
  return {
    ...record,
    stack: stack
      .split('\n')
      .map((line) => redactString(line).replace(STACK_LINE_SECRET_PATTERN, `$1=${REDACTED_VALUE}`))
      .join('\n'),
  };
};

type CursorPayload = {
  ts: string;
  idx: number;
};

type QuerySystemLogOptions = {
  level?: SystemLogLevel;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  cursor?: string;
};

type QueryableSystemLogEntry = SystemLogEntry & { idx: number };

export type QuerySystemLogResponse = {
  entries: SystemLogEntry[];
  page: {
    limit: number;
    returned: number;
    has_more: boolean;
    next_cursor: string | null;
  };
};

const parseCursor = (value: string | undefined): CursorPayload | null => {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as CursorPayload;
    if (!parsed || typeof parsed.ts !== 'string' || !Number.isInteger(parsed.idx)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const encodeCursor = (cursor: CursorPayload): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

const filePathForRotation = (index: number) => (
  `${LOG_PATH}.${index}${COMPRESS_ROTATED_LOGS ? '.gz' : ''}`
);

const removeLogFileIfPresent = (filePath: string) => {
  if (existsSync(filePath)) rmSync(filePath, { force: true });
};

const cleanupByAge = () => {
  const cutoff = Date.now() - MAX_LOG_AGE_MS;
  const dir = path.dirname(LOG_PATH);
  const base = path.basename(LOG_PATH);
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${base}.`))
    .map((entry) => path.join(dir, entry.name));
  candidates.forEach((candidate) => {
    try {
      const stats = statSync(candidate);
      if (stats.mtimeMs < cutoff) removeLogFileIfPresent(candidate);
    } catch {
      // best effort cleanup
    }
  });
};

const totalLogBytes = () => {
  const dir = path.dirname(LOG_PATH);
  const base = path.basename(LOG_PATH);
  let total = 0;
  try {
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (entry.name === base || entry.name.startsWith(`${base}.`)))
      .forEach((entry) => {
        total += statSync(path.join(dir, entry.name)).size;
      });
  } catch {
    return total;
  }
  return total;
};

const enforceDiskCap = (incomingBytes: number) => {
  let total = totalLogBytes();
  if (total + incomingBytes <= MAX_LOG_DISK_BYTES) return;
  for (let index = MAX_ROTATED_FILES; index >= 1 && total + incomingBytes > MAX_LOG_DISK_BYTES; index -= 1) {
    const filePath = filePathForRotation(index);
    if (!existsSync(filePath)) continue;
    try {
      const fileSize = statSync(filePath).size;
      rmSync(filePath, { force: true });
      total -= fileSize;
    } catch {
      // fail-open behavior
      return;
    }
  }
};

const rotateIfNeeded = () => {
  if (!existsSync(LOG_PATH)) return;
  const size = statSync(LOG_PATH).size;
  if (size < MAX_LOG_FILE_BYTES) return;
  cleanupByAge();
  for (let index = MAX_ROTATED_FILES; index >= 1; index -= 1) {
    const src = filePathForRotation(index);
    if (!existsSync(src)) continue;
    if (index === MAX_ROTATED_FILES) {
      removeLogFileIfPresent(src);
      continue;
    }
    removeLogFileIfPresent(filePathForRotation(index + 1));
    renameSync(src, filePathForRotation(index + 1));
  }
  if (COMPRESS_ROTATED_LOGS) {
    const content = readFileSync(LOG_PATH);
    writeFileSync(filePathForRotation(1), gzipSync(content));
    truncateSync(LOG_PATH, 0);
    return;
  }
  renameSync(LOG_PATH, filePathForRotation(1));
};

const rememberEntry = (entry: SystemLogEntry) => {
  recentEntries.push(entry);
  if (recentEntries.length > MAX_RECENT_ENTRIES) {
    recentEntries.splice(0, recentEntries.length - MAX_RECENT_ENTRIES);
  }
};

export const appendSystemLog = (entry: Omit<SystemLogEntry, 'timestamp' | 'details'> & { timestamp?: string; details?: unknown }) => {
  const normalizedEntry: SystemLogEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    level: entry.level,
    area: entry.area,
    message: redactString(entry.message),
    details: entry.details === undefined ? undefined : sanitizeLogDetails(entry.details),
    request_id: entry.request_id?.trim() ? entry.request_id.trim() : undefined,
  };

  rememberEntry(normalizedEntry);

  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    rotateIfNeeded();
    const line = `${JSON.stringify(normalizedEntry)}\n`;
    enforceDiskCap(Buffer.byteLength(line, 'utf8'));
    if (totalLogBytes() + Buffer.byteLength(line, 'utf8') > MAX_LOG_DISK_BYTES) return normalizedEntry;
    appendFileSync(LOG_PATH, line, 'utf8');
  } catch {
    // fail-open: never throw while handling API requests
  }

  return normalizedEntry;
};

export const getRecentSystemLogs = (limit = MAX_RECENT_ENTRIES): SystemLogEntry[] => {
  const normalizedLimit = Math.max(1, Math.min(MAX_RECENT_ENTRIES, Math.floor(limit)));
  return [...recentEntries].slice(-normalizedLimit).reverse();
};

const parseLogFile = (filePath: string, startIdx: number): QueryableSystemLogEntry[] => {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim());
    return lines.flatMap((line, lineIndex) => {
      try {
        const parsed = JSON.parse(line) as SystemLogEntry;
        if (!parsed || typeof parsed.timestamp !== 'string' || typeof parsed.message !== 'string') return [];
        return [{ ...parsed, idx: startIdx + lineIndex }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

const parseGzipLogFile = (filePath: string, startIdx: number): QueryableSystemLogEntry[] => {
  try {
    const raw = gunzipSync(readFileSync(filePath)).toString('utf8');
    const lines = raw.split('\n').filter((line) => line.trim());
    return lines.flatMap((line, lineIndex) => {
      try {
        const parsed = JSON.parse(line) as SystemLogEntry;
        if (!parsed || typeof parsed.timestamp !== 'string' || typeof parsed.message !== 'string') return [];
        return [{ ...parsed, idx: startIdx + lineIndex }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

const readAllLogEntries = (): QueryableSystemLogEntry[] => {
  const dir = path.dirname(LOG_PATH);
  const base = path.basename(LOG_PATH);
  const files = (() => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && (entry.name === base || entry.name.startsWith(`${base}.`)))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    } catch {
      return [] as string[];
    }
  })();
  let idx = 0;
  const entries: QueryableSystemLogEntry[] = [];
  files.forEach((fileName) => {
    const filePath = path.join(dir, fileName);
    const parsed = fileName.endsWith('.gz')
      ? parseGzipLogFile(filePath, idx)
      : parseLogFile(filePath, idx);
    entries.push(...parsed);
    idx += parsed.length;
  });
  return entries;
};

const matchesQuery = (entry: SystemLogEntry, options: QuerySystemLogOptions) => {
  if (options.level && entry.level !== options.level) return false;
  if (options.from && entry.timestamp < options.from) return false;
  if (options.to && entry.timestamp > options.to) return false;
  if (options.q) {
    const haystack = JSON.stringify([entry.message, entry.area, entry.details]).toLowerCase();
    if (!haystack.includes(options.q.toLowerCase())) return false;
  }
  return true;
};

export const querySystemLogs = (options: QuerySystemLogOptions): QuerySystemLogResponse => {
  const requestedLimit = Number.isFinite(options.limit) ? Number(options.limit) : 50;
  const limit = Math.max(1, Math.min(200, Math.floor(requestedLimit)));
  const cursor = parseCursor(options.cursor);
  const sorted = readAllLogEntries()
    .filter((entry) => matchesQuery(entry, options))
    .sort((a, b) => (a.timestamp === b.timestamp ? b.idx - a.idx : b.timestamp.localeCompare(a.timestamp)));
  const paged = cursor
    ? sorted.filter((entry) => (entry.timestamp < cursor.ts) || (entry.timestamp === cursor.ts && entry.idx < cursor.idx))
    : sorted;
  const slice = paged.slice(0, limit);
  const last = slice[slice.length - 1];
  return {
    entries: slice.map(({ idx: _idx, ...entry }) => entry),
    page: {
      limit,
      returned: slice.length,
      has_more: paged.length > slice.length,
      next_cursor: last ? encodeCursor({ ts: last.timestamp, idx: last.idx }) : null,
    },
  };
};

export const clearSystemLogs = () => {
  recentEntries.splice(0, recentEntries.length);
  try {
    if (existsSync(LOG_PATH)) truncateSync(LOG_PATH, 0);
    for (let index = 1; index <= MAX_ROTATED_FILES; index += 1) {
      removeLogFileIfPresent(filePathForRotation(index));
    }
  } catch {
    // fail-open: never throw while handling API requests
  }
};

const getFatalDiagnosticMetadata = () => ({
  app_version: process.env.npm_package_version ?? process.env.APP_VERSION ?? 'unknown',
  build_id: process.env.BUILD_ID ?? process.env.VITE_BUILD_ID ?? 'dev',
  runtime: process.version,
  pid: process.pid,
  uptime_sec: Math.round(process.uptime()),
});

export const logFatalProcessEvent = (type: 'unhandledRejection' | 'uncaughtException', payload: unknown) => {
  appendSystemLog({
    level: 'fatal',
    area: 'process',
    message: type === 'unhandledRejection' ? 'Unhandled promise rejection' : 'Uncaught exception',
    details: {
      event_type: type,
      payload: payload instanceof Error ? { name: payload.name, message: payload.message, stack: payload.stack } : payload,
      ...getFatalDiagnosticMetadata(),
    },
  });
};

let fatalHandlersRegistered = false;

export const registerProcessFatalHandlers = () => {
  if (fatalHandlersRegistered) return;
  fatalHandlersRegistered = true;
  process.on('unhandledRejection', (reason) => {
    logFatalProcessEvent('unhandledRejection', reason);
  });
  process.on('uncaughtException', (error) => {
    logFatalProcessEvent('uncaughtException', error);
  });
};
