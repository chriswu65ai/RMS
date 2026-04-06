import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs';
import path from 'node:path';

export type SystemLogLevel = 'info' | 'warn' | 'error';

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
const LOG_PATH = path.resolve(process.cwd(), 'data/system.log');
const LOG_ROTATED_PATH = path.resolve(process.cwd(), 'data/system.log.1');

const recentEntries: SystemLogEntry[] = [];

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|secret|token|password|authorization|auth|bearer)/i;
const SENSITIVE_VALUE_PATTERN = /((?:api[_-]?key|secret|token|password)\s*[:=]\s*)(['"]?)[^\s'",}]+/gi;
const REDACTED_VALUE = '[REDACTED]';

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

const rotateIfNeeded = () => {
  if (!existsSync(LOG_PATH)) return;
  const size = statSync(LOG_PATH).size;
  if (size < MAX_LOG_FILE_BYTES) return;
  if (existsSync(LOG_ROTATED_PATH)) rmSync(LOG_ROTATED_PATH, { force: true });
  renameSync(LOG_PATH, LOG_ROTATED_PATH);
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
    details: entry.details === undefined ? undefined : redactSensitive(entry.details),
    request_id: entry.request_id?.trim() ? entry.request_id.trim() : undefined,
  };

  rememberEntry(normalizedEntry);

  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    rotateIfNeeded();
    appendFileSync(LOG_PATH, `${JSON.stringify(normalizedEntry)}\n`, 'utf8');
  } catch {
    // fail-open: never throw while handling API requests
  }

  return normalizedEntry;
};

export const getRecentSystemLogs = (limit = MAX_RECENT_ENTRIES): SystemLogEntry[] => {
  const normalizedLimit = Math.max(1, Math.min(MAX_RECENT_ENTRIES, Math.floor(limit)));
  return [...recentEntries].slice(-normalizedLimit).reverse();
};

export const clearSystemLogs = () => {
  recentEntries.splice(0, recentEntries.length);
  try {
    if (existsSync(LOG_PATH)) truncateSync(LOG_PATH, 0);
  } catch {
    // fail-open: never throw while handling API requests
  }
};
