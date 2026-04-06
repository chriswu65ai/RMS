import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FALLBACK_MODELS,
  providerRegistry,
  selectBestModel,
  supportsToolCalling,
  type AgentProvider,
  type AgentToolCall,
  type AgentToolDefinition,
} from './agentProviders';
import { type SearchResult } from './searchProviders';
import { runAgentToolOrchestration } from './agentToolOrchestrator';
import { CHAT_TOOLS, isSupportedChatTool, runChatToolOrchestration } from './chatToolOrchestrator';
import { processResponseCitations } from './response/citation_pipeline';
import { decideWebSearchRouting, shouldRenderCitationsForChatPrompt } from './chatRoutingHeuristics';
import { secretStore } from './secretStore';

type WorkspaceRow = { id: string; name: string; created_at: string; updated_at: string };
type FolderRow = { id: string; workspace_id: string; parent_id: string | null; name: string; path: string; created_at: string; updated_at: string };

type NewResearchTaskRow = {
  id: string;
  title: string;
  details: string;
  ticker: string;
  note_type: string;
  assignee: string;
  priority: string;
  deadline: string;
  status: 'ideas' | 'researching' | 'completed';
  date_completed: string;
  archived: number;
  linked_note_file_id: string;
  linked_note_path: string;
  research_location_folder_id: string;
  research_location_path: string;
  created_at: string;
  updated_at: string;
};
const VALID_TASK_PRIORITIES = new Set(['', 'low', 'medium', 'high']);

type TaskActivityRow = {
  id: string;
  task_id: string;
  event_type: string;
  description: string;
  created_at: string;
};

type ResearchNoteRow = {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  name: string;
  path: string;
  content: string;
  frontmatter_json: string | null;
  is_template: number;
  created_at: string;
  updated_at: string;
};

type AgentSettingsRow = {
  default_provider: AgentProvider;
  default_model: string;
  generation_params_json: string | null;
};

type WebSearchProvider = 'duckduckgo' | 'searxng';
type WebSearchMode = 'single' | 'deep';
type WebSearchRecency = 'any' | '7d' | '30d' | '365d';
type WebSearchDomainPolicy = 'open_web' | 'prefer_list' | 'only_list';

type AgentGenerationParams = {
  temperature?: number;
  maxTokens?: number;
  local_connection?: {
    base_url?: string;
    model?: string;
    B?: number;
  };
  web_search?: {
    enabled: boolean;
    fail_open_on_tool_error: boolean;
    provider: WebSearchProvider;
    mode: WebSearchMode;
    max_results: number;
    timeout_ms: number;
    safe_search: boolean;
    recency: WebSearchRecency;
    domain_policy: WebSearchDomainPolicy;
    source_citation: boolean;
    provider_config?: {
      searxng?: {
        base_url: string;
        use_json_api: boolean;
      };
    };
  };
} | null;

type PreparedWebSearchContext = {
  enabled: boolean;
  provider: WebSearchProvider;
  mode: WebSearchMode;
  queryCount: number;
  sourceCount: number;
};

type OllamaRuntimeConfig = {
  baseUrl: string;
  model: string;
};

type AgentActivityLogRow = {
  id: string;
  timestamp: string;
  note_id: string;
  action: string;
  trigger_source: string;
  initiated_by: string;
  provider: string;
  model: string;
  status: string;
  duration_ms: number | null;
  input_chars: number;
  output_chars: number;
  token_estimate: number | null;
  cost_estimate_usd: number | null;
  error_message_short: string | null;
  search_warning: number;
  search_warning_message: string | null;
  web_search_enabled: number;
  tool_calls_attempted: number;
  tool_calls_succeeded: number;
  search_query_count: number;
  source_count: number;
  tool_failure_reason: string | null;
  citation_events_json: string | null;
};

type PreferredSourceRow = {
  id: string;
  domain: string;
  weight: number;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type AttachmentRow = {
  id: string;
  workspace_id: string;
  storage_relpath: string;
  original_name: string;
  mime_type: string;
  extension: string;
  size_bytes: number;
  sha256: string;
  estimated_tokens: number;
  parse_status: 'parsed' | 'pending' | 'failed';
  parsed_text: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type AttachmentLinkRow = {
  id: string;
  attachment_id: string;
  link_type: 'task' | 'note';
  link_id: string;
  created_at: string;
};

type AttachmentSettingsRow = {
  id: number;
  quota_mb: number;
  retention_days: number;
};

type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

type ChatSessionRow = {
  id: string;
  user_id: string;
  title: string;
  is_primary: number;
  created_at: string;
  updated_at: string;
};

type ChatMessageRow = {
  id: string;
  session_id: string;
  role: ChatRole;
  content: string;
  provider: string | null;
  model: string | null;
  stream_json: string | null;
  metadata_json: string | null;
  created_at: string;
};

type ChatPendingActionRow = {
  id: string;
  session_id: string;
  action_key: string;
  draft_json: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  created_at: string;
  updated_at: string;
};

type ChatMemorySnapshotRow = {
  id: string;
  session_id: string;
  rolling_summary: string;
  pinned_memory_json: string | null;
  last_message_id: string | null;
  created_at: string;
  updated_at: string;
};

type ChatSettingsRow = {
  id: string;
  user_id: string;
  policy_json: string | null;
  profile_json: string | null;
  created_at: string;
  updated_at: string;
};

type ChatPurgeRange = '24h' | '7d' | 'all';
type CanonicalChatActionMode = 'assist' | 'confirm_required' | 'manual_only';
type ChatCommandName = 'task' | 'note' | 'confirm' | 'cancel' | 'help';
type ChatCommandPrefixMode = 'on' | 'off';
type ChatCommandPrefixMap = Record<ChatCommandName, string>;
type ChatIntentRoute = 'conversation' | 'action' | 'ambiguous';
type ChatIntentConfidence = 'low' | 'medium' | 'high';

const dbPath = process.env.SQLITE_PATH ?? path.resolve(process.cwd(), 'data/researchmanager.db');
mkdirSync(path.dirname(dbPath), { recursive: true });
const attachmentsRootPath = path.resolve(process.cwd(), 'data/attachments');
const attachmentsTmpPath = path.join(attachmentsRootPath, '.tmp');
mkdirSync(attachmentsTmpPath, { recursive: true });
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_LINKS_PER_ENTITY = 5;
const DEFAULT_ATTACHMENT_QUOTA_MB = 500;
const DEFAULT_ATTACHMENT_RETENTION_DAYS = 30;
const ATTACHMENT_CONTEXT_TOKEN_BUDGET = 1_500;
const DEFAULT_PENDING_ACTION_TTL_MS = 30 * 60 * 1000;
const pendingActionTtlMs = (() => {
  const rawMinutes = Number(process.env.PENDING_ACTION_TTL_MINUTES ?? '30');
  if (!Number.isFinite(rawMinutes) || rawMinutes <= 0) return DEFAULT_PENDING_ACTION_TTL_MS;
  return Math.floor(rawMinutes * 60 * 1000);
})();
let initialized = false;

const sqlEscape = (value: unknown) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
};

const execSql = (sql: string) => {
  execFileSync('sqlite3', [dbPath, sql], { stdio: 'pipe' });
};

const queryJson = <T>(sql: string): T[] => {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' });
  const trimmed = out.trim();
  return trimmed ? (JSON.parse(trimmed) as T[]) : [];
};

const parseJsonOrNull = <T>(value: string | null | undefined): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

type ChatContextPolicy = {
  max_context_messages: number;
  summarize_after_messages: number;
  include_pinned_memory: boolean;
};

const DEFAULT_CHAT_CONTEXT_POLICY: ChatContextPolicy = {
  max_context_messages: 40,
  summarize_after_messages: 80,
  include_pinned_memory: true,
};

const asObjectRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const coerceChatContextPolicy = (value: unknown): ChatContextPolicy => {
  const record = asObjectRecord(value) ?? {};
  const maxContextMessages = Number(record.max_context_messages);
  const summarizeAfterMessages = Number(record.summarize_after_messages);
  return {
    max_context_messages: Number.isFinite(maxContextMessages) ? Math.max(2, Math.min(80, Math.floor(maxContextMessages))) : DEFAULT_CHAT_CONTEXT_POLICY.max_context_messages,
    summarize_after_messages: Number.isFinite(summarizeAfterMessages) ? Math.max(10, Math.min(400, Math.floor(summarizeAfterMessages))) : DEFAULT_CHAT_CONTEXT_POLICY.summarize_after_messages,
    include_pinned_memory: record.include_pinned_memory === undefined ? true : Boolean(record.include_pinned_memory),
  };
};

const buildRollingSummaryFromMessages = (messages: ChatMessageRow[], charBudget = 1600): string => {
  if (messages.length === 0) return '';
  const lines: string[] = [];
  let consumed = 0;
  for (const message of messages) {
    if (consumed >= charBudget) break;
    const normalizedRole = message.role.toUpperCase();
    const compact = message.content.replace(/\s+/g, ' ').trim();
    const remaining = Math.max(0, charBudget - consumed);
    if (remaining <= 0) break;
    const segment = compact.slice(0, Math.min(220, remaining));
    const next = `- ${normalizedRole}: ${segment}`;
    lines.push(next);
    consumed += next.length;
  }
  return lines.join('\n');
};

const buildChatContextInput = (args: {
  inputText: string;
  recentMessages: ChatMessageRow[];
  snapshot: (ChatMemorySnapshotRow & { pinnedMemory: Record<string, unknown> | null }) | null;
  policy: ChatContextPolicy;
  profile: Record<string, unknown> | null;
}): { prompt: string; meta: Record<string, unknown> } => {
  const sections: string[] = [];
  const profile = args.profile && Object.keys(args.profile).length > 0 ? args.profile : null;
  if (profile) sections.push(`[PROFILE]\n${JSON.stringify(profile)}`);
  const summary = args.snapshot?.rolling_summary?.trim() ?? '';
  if (summary) sections.push(`[ROLLING_SUMMARY]\n${summary}`);
  if (args.policy.include_pinned_memory && args.snapshot?.pinnedMemory && Object.keys(args.snapshot.pinnedMemory).length > 0) {
    sections.push(`[PINNED_MEMORY]\n${JSON.stringify(args.snapshot.pinnedMemory)}`);
  }
  if (args.recentMessages.length > 0) {
    const recentLines = args.recentMessages.map((message) => `${message.role.toUpperCase()}: ${message.content}`);
    sections.push(`[RECENT_TURNS]\n${recentLines.join('\n')}`);
  }
  sections.push(`[USER_INPUT]\n${args.inputText}`);
  return {
    prompt: sections.join('\n\n'),
    meta: {
      injected_recent_turns: args.recentMessages.length,
      has_summary: Boolean(summary),
      has_pinned_memory: Boolean(args.snapshot?.pinnedMemory && Object.keys(args.snapshot.pinnedMemory).length > 0),
      has_profile: Boolean(profile),
    },
  };
};

const emitStructuredLog = (event: string, payload: Record<string, unknown>) => {
  console.info(`[local-api:${event}]`, JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  }));
};

const getOrCreatePrimaryChatSession = (userId: string, title = 'Primary chat'): ChatSessionRow => {
  const existing = queryJson<ChatSessionRow>(`
    select * from chat_sessions
    where user_id = ${sqlEscape(userId)} and is_primary = 1
    order by created_at asc
    limit 1
  `)[0];
  if (existing) return existing;
  const id = randomUUID();
  const now = new Date().toISOString();
  execSql(`
    insert into chat_sessions (id, user_id, title, is_primary, created_at, updated_at)
    values (${sqlEscape(id)}, ${sqlEscape(userId)}, ${sqlEscape(title)}, 1, ${sqlEscape(now)}, ${sqlEscape(now)})
  `);
  return queryJson<ChatSessionRow>(`select * from chat_sessions where id = ${sqlEscape(id)} limit 1`)[0];
};

const DEFAULT_CHAT_USER_ID = 'local-user';
const DEFAULT_CHAT_SETTINGS_POLICY = DEFAULT_CHAT_CONTEXT_POLICY;
const DEFAULT_CHAT_ACTION_MODE: CanonicalChatActionMode = 'assist';
const DEFAULT_CHAT_COMMAND_PREFIX_MODE: ChatCommandPrefixMode = 'off';
const DEFAULT_CHAT_COMMAND_PREFIX_MAP: ChatCommandPrefixMap = {
  task: '/task',
  note: '/note',
  confirm: '/confirm',
  cancel: '/cancel',
  help: '/help',
};
const LEGACY_CHAT_ACTION_MODE_MAP: Record<string, CanonicalChatActionMode> = {
  assist: 'assist',
  act: 'confirm_required',
  confirm: 'confirm_required',
  require_confirm: 'confirm_required',
  requires_confirm: 'confirm_required',
  confirm_required: 'confirm_required',
  manual: 'manual_only',
  manual_only: 'manual_only',
};

const resolveChatActionMode = (rawMode: unknown): { mode: CanonicalChatActionMode; normalizedFrom: string | null; warningCode?: 'unknown_chat_action_mode' } => {
  if (typeof rawMode !== 'string') return { mode: DEFAULT_CHAT_ACTION_MODE, normalizedFrom: null };
  const normalizedInput = rawMode.trim().toLowerCase();
  const mapped = LEGACY_CHAT_ACTION_MODE_MAP[normalizedInput];
  if (mapped) {
    return {
      mode: mapped,
      normalizedFrom: normalizedInput !== mapped ? normalizedInput : null,
    };
  }
  return {
    mode: DEFAULT_CHAT_ACTION_MODE,
    normalizedFrom: normalizedInput || null,
    warningCode: 'unknown_chat_action_mode',
  };
};

const normalizeChatSettingsPolicy = (
  policy: Record<string, unknown> | null | undefined,
): {
  policy: Record<string, unknown>;
  actionMode: CanonicalChatActionMode;
  normalizedFrom: string | null;
  commandPrefixMode: ChatCommandPrefixMode;
  commandPrefixMap: ChatCommandPrefixMap;
  warningCode?: 'unknown_chat_action_mode';
} => {
  const nextPolicy = { ...(policy ?? {}) };
  const resolved = resolveChatActionMode(nextPolicy.action_mode);
  nextPolicy.action_mode = resolved.mode;
  const rawPrefixMode = nextPolicy.command_prefix_mode;
  const normalizedPrefixMode: ChatCommandPrefixMode = rawPrefixMode === true || rawPrefixMode === 'on' ? 'on' : 'off';
  const rawPrefixMap = asObjectRecord(nextPolicy.command_prefix_map) ?? {};
  const normalizedPrefixMap: ChatCommandPrefixMap = {
    task: typeof rawPrefixMap.task === 'string' && rawPrefixMap.task.trim() ? rawPrefixMap.task.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.task,
    note: typeof rawPrefixMap.note === 'string' && rawPrefixMap.note.trim() ? rawPrefixMap.note.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.note,
    confirm: typeof rawPrefixMap.confirm === 'string' && rawPrefixMap.confirm.trim() ? rawPrefixMap.confirm.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.confirm,
    cancel: typeof rawPrefixMap.cancel === 'string' && rawPrefixMap.cancel.trim() ? rawPrefixMap.cancel.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.cancel,
    help: typeof rawPrefixMap.help === 'string' && rawPrefixMap.help.trim() ? rawPrefixMap.help.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.help,
  };
  nextPolicy.command_prefix_mode = normalizedPrefixMode;
  nextPolicy.command_prefix_map = normalizedPrefixMap;
  return {
    policy: nextPolicy,
    actionMode: resolved.mode,
    normalizedFrom: resolved.normalizedFrom,
    commandPrefixMode: normalizedPrefixMode,
    commandPrefixMap: normalizedPrefixMap,
    warningCode: resolved.warningCode,
  };
};

const getOrCreateChatSettings = (userId: string): ChatSettingsRow => {
  const existing = queryJson<ChatSettingsRow>(`select * from chat_settings where user_id = ${sqlEscape(userId)} limit 1`)[0];
  if (existing) return existing;
  const now = new Date().toISOString();
  const id = randomUUID();
  execSql(`
    insert into chat_settings (id, user_id, policy_json, profile_json, created_at, updated_at)
    values (
      ${sqlEscape(id)},
      ${sqlEscape(userId)},
      ${sqlEscape(JSON.stringify({
        ...DEFAULT_CHAT_SETTINGS_POLICY,
        action_mode: DEFAULT_CHAT_ACTION_MODE,
        command_prefix_mode: DEFAULT_CHAT_COMMAND_PREFIX_MODE,
        command_prefix_map: DEFAULT_CHAT_COMMAND_PREFIX_MAP,
      }))},
      null,
      ${sqlEscape(now)},
      ${sqlEscape(now)}
    )
  `);
  return queryJson<ChatSettingsRow>(`select * from chat_settings where id = ${sqlEscape(id)} limit 1`)[0];
};

const persistChatTurnAtomic = (input: {
  sessionId: string;
  userContent: string;
  assistantContent: string;
  provider: AgentProvider;
  model: string;
  stream: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}): { userMessageId: string; assistantMessageId: string } => {
  const now = new Date().toISOString();
  const userId = randomUUID();
  const assistantId = randomUUID();
  execSql(`
    begin;
    insert into chat_messages (id, session_id, role, content, provider, model, stream_json, metadata_json, created_at)
    values (
      ${sqlEscape(userId)},
      ${sqlEscape(input.sessionId)},
      'user',
      ${sqlEscape(input.userContent)},
      null,
      null,
      null,
      null,
      ${sqlEscape(now)}
    );
    insert into chat_messages (id, session_id, role, content, provider, model, stream_json, metadata_json, created_at)
    values (
      ${sqlEscape(assistantId)},
      ${sqlEscape(input.sessionId)},
      'assistant',
      ${sqlEscape(input.assistantContent)},
      ${sqlEscape(input.provider)},
      ${sqlEscape(input.model)},
      ${sqlEscape(input.stream ? JSON.stringify(input.stream) : null)},
      ${sqlEscape(input.metadata ? JSON.stringify(input.metadata) : null)},
      ${sqlEscape(now)}
    );
    update chat_sessions set updated_at = ${sqlEscape(now)} where id = ${sqlEscape(input.sessionId)};
    commit;
  `);
  return { userMessageId: userId, assistantMessageId: assistantId };
};

type AppendChatMessageInput = {
  sessionId: string;
  role: ChatRole;
  content: string;
  provider?: string | null;
  model?: string | null;
  stream?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

const appendChatMessage = (input: AppendChatMessageInput): ChatMessageRow => {
  const id = randomUUID();
  const now = new Date().toISOString();
  execSql(`
    insert into chat_messages (id, session_id, role, content, provider, model, stream_json, metadata_json, created_at)
    values (
      ${sqlEscape(id)},
      ${sqlEscape(input.sessionId)},
      ${sqlEscape(input.role)},
      ${sqlEscape(input.content)},
      ${sqlEscape(input.provider ?? null)},
      ${sqlEscape(input.model ?? null)},
      ${sqlEscape(input.stream ? JSON.stringify(input.stream) : null)},
      ${sqlEscape(input.metadata ? JSON.stringify(input.metadata) : null)},
      ${sqlEscape(now)}
    );
    update chat_sessions set updated_at = ${sqlEscape(now)} where id = ${sqlEscape(input.sessionId)};
  `);
  return queryJson<ChatMessageRow>(`select * from chat_messages where id = ${sqlEscape(id)} limit 1`)[0];
};

const loadPaginatedChatMessages = (sessionId: string, limit = 50, beforeCreatedAt?: string): ChatMessageRow[] => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
  const beforeClause = beforeCreatedAt ? `and created_at < ${sqlEscape(beforeCreatedAt)}` : '';
  return queryJson<ChatMessageRow>(`
    select * from chat_messages
    where session_id = ${sqlEscape(sessionId)} ${beforeClause}
    order by created_at desc, id desc
    limit ${safeLimit}
  `).reverse();
};

const savePendingActionDraft = (
  sessionId: string,
  actionKey: string,
  draft: Record<string, unknown>,
  status: ChatPendingActionRow['status'] = 'pending',
): ChatPendingActionRow => {
  const now = new Date().toISOString();
  const existing = queryJson<Pick<ChatPendingActionRow, 'id'>>(
    `select id from chat_pending_actions where session_id = ${sqlEscape(sessionId)} and action_key = ${sqlEscape(actionKey)} limit 1`,
  )[0];
  const id = existing?.id ?? randomUUID();
  execSql(`
    insert into chat_pending_actions (id, session_id, action_key, draft_json, status, created_at, updated_at)
    values (${sqlEscape(id)}, ${sqlEscape(sessionId)}, ${sqlEscape(actionKey)}, ${sqlEscape(JSON.stringify(draft))}, ${sqlEscape(status)}, ${sqlEscape(now)}, ${sqlEscape(now)})
    on conflict(id) do update set
      draft_json = excluded.draft_json,
      status = excluded.status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at;
  `);
  return queryJson<ChatPendingActionRow>(`select * from chat_pending_actions where id = ${sqlEscape(id)} limit 1`)[0];
};

const cancelExpiredPendingActionDrafts = (sessionId: string): number => {
  const cutoff = new Date(Date.now() - pendingActionTtlMs).toISOString();
  const expiredCount = queryJson<{ total: number }>(`
    select count(*) as total from chat_pending_actions
    where session_id = ${sqlEscape(sessionId)}
      and status = 'pending'
      and updated_at < ${sqlEscape(cutoff)}
  `)[0]?.total ?? 0;
  if (!expiredCount) return 0;
  execSql(`
    update chat_pending_actions
    set status = 'cancelled',
        updated_at = ${sqlEscape(new Date().toISOString())}
    where session_id = ${sqlEscape(sessionId)}
      and status = 'pending'
      and updated_at < ${sqlEscape(cutoff)};
  `);
  return expiredCount;
};

const cancelAllPendingActionDrafts = (sessionId: string): number => {
  const pendingCount = queryJson<{ total: number }>(`
    select count(*) as total from chat_pending_actions
    where session_id = ${sqlEscape(sessionId)}
      and status = 'pending'
  `)[0]?.total ?? 0;
  if (!pendingCount) return 0;
  execSql(`
    update chat_pending_actions
    set status = 'cancelled',
        updated_at = ${sqlEscape(new Date().toISOString())}
    where session_id = ${sqlEscape(sessionId)}
      and status = 'pending';
  `);
  return pendingCount;
};

const loadPendingActionDraft = (sessionId: string, actionKey: string): (ChatPendingActionRow & { draft: Record<string, unknown> | null }) | null => {
  cancelExpiredPendingActionDrafts(sessionId);
  const row = queryJson<ChatPendingActionRow>(
    `select * from chat_pending_actions where session_id = ${sqlEscape(sessionId)} and action_key = ${sqlEscape(actionKey)} and status = 'pending' limit 1`,
  )[0];
  if (!row) return null;
  return { ...row, draft: parseJsonOrNull<Record<string, unknown>>(row.draft_json) };
};

const loadLatestPendingChatToolDraft = (sessionId: string): (ChatPendingActionRow & { draft: Record<string, unknown> | null }) | null => {
  cancelExpiredPendingActionDrafts(sessionId);
  const row = queryJson<ChatPendingActionRow>(`
    select * from chat_pending_actions
    where session_id = ${sqlEscape(sessionId)}
      and status = 'pending'
      and action_key like 'chat_tool:%'
    order by updated_at desc, created_at desc, id desc
    limit 1
  `)[0];
  if (!row) return null;
  return { ...row, draft: parseJsonOrNull<Record<string, unknown>>(row.draft_json) };
};

type SaveMemorySnapshotInput = {
  sessionId: string;
  rollingSummary: string;
  pinnedMemory?: Record<string, unknown> | null;
  lastMessageId?: string | null;
};

const saveMemorySnapshot = (input: SaveMemorySnapshotInput): ChatMemorySnapshotRow => {
  const now = new Date().toISOString();
  const existing = queryJson<Pick<ChatMemorySnapshotRow, 'id'>>(`select id from chat_memory_snapshots where session_id = ${sqlEscape(input.sessionId)} limit 1`)[0];
  const id = existing?.id ?? randomUUID();
  execSql(`
    insert into chat_memory_snapshots (id, session_id, rolling_summary, pinned_memory_json, last_message_id, created_at, updated_at)
    values (
      ${sqlEscape(id)},
      ${sqlEscape(input.sessionId)},
      ${sqlEscape(input.rollingSummary)},
      ${sqlEscape(input.pinnedMemory ? JSON.stringify(input.pinnedMemory) : null)},
      ${sqlEscape(input.lastMessageId ?? null)},
      ${sqlEscape(now)},
      ${sqlEscape(now)}
    )
    on conflict(id) do update set
      rolling_summary = excluded.rolling_summary,
      pinned_memory_json = excluded.pinned_memory_json,
      last_message_id = excluded.last_message_id,
      updated_at = excluded.updated_at;
  `);
  return queryJson<ChatMemorySnapshotRow>(`select * from chat_memory_snapshots where id = ${sqlEscape(id)} limit 1`)[0];
};

const loadMemorySnapshot = (sessionId: string): (ChatMemorySnapshotRow & { pinnedMemory: Record<string, unknown> | null }) | null => {
  const row = queryJson<ChatMemorySnapshotRow>(`select * from chat_memory_snapshots where session_id = ${sqlEscape(sessionId)} limit 1`)[0];
  if (!row) return null;
  return { ...row, pinnedMemory: parseJsonOrNull<Record<string, unknown>>(row.pinned_memory_json) };
};

const purgeChatHistoryByRange = (sessionId: string, range: ChatPurgeRange): { deletedMessages: number; deletedPendingActions: number } => {
  const cutoff = range === 'all'
    ? null
    : new Date(Date.now() - (range === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000)).toISOString();
  const rangeClause = cutoff ? `and created_at >= ${sqlEscape(cutoff)}` : '';
  const pendingRangeClause = cutoff ? `and updated_at >= ${sqlEscape(cutoff)}` : '';
  const deletedMessages = queryJson<{ total: number }>(`
    select count(*) as total from chat_messages where session_id = ${sqlEscape(sessionId)} ${rangeClause}
  `)[0]?.total ?? 0;
  const deletedPendingActions = queryJson<{ total: number }>(`
    select count(*) as total from chat_pending_actions where session_id = ${sqlEscape(sessionId)} ${pendingRangeClause}
  `)[0]?.total ?? 0;
  execSql(`
    delete from chat_messages where session_id = ${sqlEscape(sessionId)} ${rangeClause};
    delete from chat_pending_actions where session_id = ${sqlEscape(sessionId)} ${pendingRangeClause};
  `);
  return { deletedMessages, deletedPendingActions };
};

type ChatTranscriptExportPayload = {
  session: ChatSessionRow;
  settings: {
    row: ChatSettingsRow | null;
    policy: Record<string, unknown> | null;
    profile: Record<string, unknown> | null;
  };
  messages: Array<ChatMessageRow & { stream: Record<string, unknown> | null; metadata: Record<string, unknown> | null }>;
  pendingActions: Array<ChatPendingActionRow & { draft: Record<string, unknown> | null }>;
  memorySnapshot: (ChatMemorySnapshotRow & { pinnedMemory: Record<string, unknown> | null }) | null;
};

const assembleTranscriptExportPayload = (sessionId: string): { json: ChatTranscriptExportPayload; markdown: string } | null => {
  const session = queryJson<ChatSessionRow>(`select * from chat_sessions where id = ${sqlEscape(sessionId)} limit 1`)[0];
  if (!session) return null;
  const settingsRow = queryJson<ChatSettingsRow>(`select * from chat_settings where user_id = ${sqlEscape(session.user_id)} limit 1`)[0] ?? null;
  const policy = parseJsonOrNull<Record<string, unknown>>(settingsRow?.policy_json);
  const profile = parseJsonOrNull<Record<string, unknown>>(settingsRow?.profile_json);
  const messages = queryJson<ChatMessageRow>(
    `select * from chat_messages where session_id = ${sqlEscape(sessionId)} order by created_at asc, id asc`,
  ).map((row) => ({
    ...row,
    stream: parseJsonOrNull<Record<string, unknown>>(row.stream_json),
    metadata: parseJsonOrNull<Record<string, unknown>>(row.metadata_json),
  }));
  const pendingActions = queryJson<ChatPendingActionRow>(
    `select * from chat_pending_actions where session_id = ${sqlEscape(sessionId)} order by created_at asc, id asc`,
  ).map((row) => ({ ...row, draft: parseJsonOrNull<Record<string, unknown>>(row.draft_json) }));
  const memorySnapshot = loadMemorySnapshot(sessionId);

  const json: ChatTranscriptExportPayload = {
    session,
    settings: { row: settingsRow, policy, profile },
    messages,
    pendingActions,
    memorySnapshot,
  };

  const markdownLines: string[] = [
    `# Chat Transcript: ${session.title}`,
    '',
    `- Session ID: \`${session.id}\``,
    `- User ID: \`${session.user_id}\``,
    `- Created: ${session.created_at}`,
    `- Updated: ${session.updated_at}`,
    '',
    '## Messages',
    '',
  ];

  if (!messages.length) {
    markdownLines.push('_No messages_');
  } else {
    for (const message of messages) {
      markdownLines.push(`### ${message.role.toUpperCase()} — ${message.created_at}`);
      if (message.provider || message.model) {
        markdownLines.push(`_${message.provider ?? 'unknown'} / ${message.model ?? 'unknown'}_`);
      }
      markdownLines.push('', message.content || '_Empty_', '');
    }
  }

  markdownLines.push('## Pending Actions', '');
  if (!pendingActions.length) {
    markdownLines.push('_No pending actions_', '');
  } else {
    for (const action of pendingActions) {
      markdownLines.push(`- **${action.action_key}** (${action.status})`);
      markdownLines.push(`  - Updated: ${action.updated_at}`);
      markdownLines.push(`  - Draft: \`${JSON.stringify(action.draft)}\``);
    }
    markdownLines.push('');
  }

  markdownLines.push('## Memory Snapshot', '');
  if (!memorySnapshot) {
    markdownLines.push('_No memory snapshot_');
  } else {
    markdownLines.push(memorySnapshot.rolling_summary || '_No summary_');
    markdownLines.push('', `Pinned: \`${JSON.stringify(memorySnapshot.pinnedMemory)}\``);
  }

  return { json, markdown: markdownLines.join('\n') };
};

const coerceLinkType = (value: unknown): 'task' | 'note' | null => (value === 'task' || value === 'note' ? value : null);

const ensureLinkTargetExists = (linkType: 'task' | 'note', linkId: string): boolean => {
  if (!linkId.trim()) return false;
  if (linkType === 'task') {
    return Boolean(queryJson<Pick<NewResearchTaskRow, 'id'>>(`select id from new_research_tasks where id = ${sqlEscape(linkId)} limit 1`)[0]);
  }
  return Boolean(queryJson<Pick<ResearchNoteRow, 'id'>>(`select id from research_notes where id = ${sqlEscape(linkId)} limit 1`)[0]);
};

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const chunkText = (text: string, maxChunkChars = 2000): string[] => {
  const normalized = text.trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  for (let index = 0; index < normalized.length; index += maxChunkChars) {
    chunks.push(normalized.slice(index, index + maxChunkChars));
  }
  return chunks;
};

const parseCsvRows = (csvText: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i] ?? '';
    const next = csvText[i + 1] ?? '';
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
};

const parseAttachmentText = (extension: string, originalName: string, rawBuffer: Buffer): { parseStatus: AttachmentRow['parse_status']; parsedText: string | null } => {
  const normalizedExtension = extension.toLowerCase();
  if (normalizedExtension === 'txt' || normalizedExtension === 'md') {
    const text = rawBuffer.toString('utf8');
    return { parseStatus: 'parsed', parsedText: text };
  }
  if (normalizedExtension === 'csv') {
    const csvText = rawBuffer.toString('utf8');
    const rows = parseCsvRows(csvText);
    if (rows.length === 0) return { parseStatus: 'parsed', parsedText: `Source: ${originalName}\nColumns: (none)\nRow count: 0` };
    const header = rows[0] ?? [];
    const dataRows = rows.slice(1);
    const windows = chunkText(
      dataRows.map((row, rowIndex) => `Row ${rowIndex + 1}: ${header.map((column, columnIndex) => `${column || `column_${columnIndex + 1}`}=${row[columnIndex] ?? ''}`).join(' | ')}`).join('\n'),
      1500,
    );
    const sampledRows = dataRows.slice(0, 3).map((row) => row.join(' | ')).join('\n');
    const sections = [
      `Source: ${originalName}`,
      `Columns: ${header.join(', ') || '(none)'}`,
      `Row count: ${dataRows.length}`,
      sampledRows ? `Sample rows:\n${sampledRows}` : 'Sample rows: (none)',
      ...windows.map((window, index) => `Window ${index + 1}:\n${window}`),
    ];
    return { parseStatus: 'parsed', parsedText: sections.join('\n\n') };
  }
  if (normalizedExtension === 'pdf' || normalizedExtension === 'docx') {
    return { parseStatus: 'pending', parsedText: null };
  }
  return { parseStatus: 'failed', parsedText: null };
};

const recordTaskEvent = (taskId: string, eventType: string, description: string) => {
  const now = new Date().toISOString();
  execSql(`insert into task_activity_events (id, task_id, event_type, description, created_at) values (${sqlEscape(randomUUID())}, ${sqlEscape(taskId)}, ${sqlEscape(eventType)}, ${sqlEscape(description)}, ${sqlEscape(now)})`);
};

const ensureInitialized = () => {
  if (initialized) return;
  execSql(`
  create table if not exists workspaces (
    id text primary key,
    name text not null,
    created_at text not null,
    updated_at text not null
  );
  create table if not exists folders (
    id text primary key,
    workspace_id text not null,
    parent_id text,
    name text not null,
    path text not null,
    created_at text not null,
    updated_at text not null,
    unique(workspace_id, path)
  );
  create table if not exists research_notes (
    id text primary key,
    workspace_id text not null,
    folder_id text,
    name text not null,
    path text not null,
    content text not null,
    frontmatter_json text,
    is_template integer not null default 0,
    created_at text not null,
    updated_at text not null,
    unique(workspace_id, path)
  );
  create table if not exists new_research_tasks (
    id text primary key,
    title text not null default '',
    details text not null default '',
    ticker text not null,
    note_type text not null default '',
    assignee text not null default '',
    priority text not null default '',
    deadline text not null default '',
    status text not null default 'ideas',
    date_completed text not null default '',
    archived integer not null default 0,
    linked_note_file_id text not null default '',
    linked_note_path text not null default '',
    research_location_folder_id text not null default '',
    research_location_path text not null default '',
    created_at text not null,
    updated_at text not null
  );
  create table if not exists task_activity_events (
    id text primary key,
    task_id text not null,
    event_type text not null,
    description text not null,
    created_at text not null
  );
  create table if not exists agent_settings (
    id integer primary key check (id = 1),
    default_provider text not null default 'minimax',
    default_model text not null default '',
    generation_params_json text
  );
  create table if not exists preferred_sources (
    id text primary key,
    domain text not null,
    weight real not null default 1,
    enabled integer not null default 1,
    created_at text not null,
    updated_at text not null,
    unique(domain)
  );
  create table if not exists agent_activity_log (
    id text primary key,
    timestamp text not null,
    note_id text not null default '',
    action text not null,
    trigger_source text not null,
    initiated_by text not null default 'user',
    provider text not null,
    model text not null,
    status text not null,
    duration_ms integer,
    input_chars integer not null default 0,
    output_chars integer not null default 0,
    token_estimate integer,
    cost_estimate_usd real,
    error_message_short text,
    search_warning integer not null default 0,
    search_warning_message text,
    web_search_enabled integer not null default 0,
    tool_calls_attempted integer not null default 0,
    tool_calls_succeeded integer not null default 0,
    search_query_count integer not null default 0,
    source_count integer not null default 0,
    tool_failure_reason text
  );
  create table if not exists attachments (
    id text primary key,
    workspace_id text not null,
    storage_relpath text not null,
    original_name text not null,
    mime_type text not null,
    extension text not null,
    size_bytes integer not null,
    sha256 text not null,
    estimated_tokens integer not null default 0,
    parse_status text not null default 'pending',
    parsed_text text,
    created_at text not null,
    updated_at text not null,
    deleted_at text
  );
  create table if not exists attachment_links (
    id text primary key,
    attachment_id text not null,
    link_type text not null,
    link_id text not null,
    created_at text not null,
    unique(attachment_id, link_type, link_id)
  );
  create index if not exists idx_attachment_links_target on attachment_links(link_type, link_id);
  create table if not exists attachment_settings (
    id integer primary key check (id = 1),
    quota_mb integer not null default 500,
    retention_days integer not null default 30
  );
  create table if not exists chat_sessions (
    id text primary key,
    user_id text not null,
    title text not null default 'Primary chat',
    is_primary integer not null default 0,
    created_at text not null,
    updated_at text not null
  );
  create unique index if not exists idx_chat_sessions_primary_user on chat_sessions(user_id) where is_primary = 1;
  create index if not exists idx_chat_sessions_user_updated on chat_sessions(user_id, updated_at desc);
  create table if not exists chat_messages (
    id text primary key,
    session_id text not null,
    role text not null,
    content text not null default '',
    provider text,
    model text,
    stream_json text,
    metadata_json text,
    created_at text not null
  );
  create index if not exists idx_chat_messages_session_created on chat_messages(session_id, created_at asc);
  create table if not exists chat_pending_actions (
    id text primary key,
    session_id text not null,
    action_key text not null,
    draft_json text not null,
    status text not null default 'pending',
    created_at text not null,
    updated_at text not null,
    unique(session_id, action_key)
  );
  create index if not exists idx_chat_pending_actions_session_updated on chat_pending_actions(session_id, updated_at desc);
  create table if not exists chat_memory_snapshots (
    id text primary key,
    session_id text not null unique,
    rolling_summary text not null default '',
    pinned_memory_json text,
    last_message_id text,
    created_at text not null,
    updated_at text not null
  );
  create table if not exists chat_settings (
    id text primary key,
    user_id text not null unique,
    policy_json text,
    profile_json text,
    created_at text not null,
    updated_at text not null
  );
  `);
  execSql(`insert or ignore into agent_settings (id, default_provider, default_model, generation_params_json) values (1, 'minimax', '', null);`);
  execSql(`insert or ignore into attachment_settings (id, quota_mb, retention_days) values (1, ${DEFAULT_ATTACHMENT_QUOTA_MB}, ${DEFAULT_ATTACHMENT_RETENTION_DAYS});`);
  try {
    execSql(`alter table agent_activity_log add column search_warning integer not null default 0;`);
  } catch {
    // existing DBs may already include this column
  }
  try {
    execSql(`alter table agent_activity_log add column search_warning_message text;`);
  } catch {
    // existing DBs may already include this column
  }
  try {
    execSql(`alter table agent_activity_log add column web_search_enabled integer not null default 0;`);
  } catch {}
  try {
    execSql(`alter table agent_activity_log add column tool_calls_attempted integer not null default 0;`);
  } catch {}
  try {
    execSql(`alter table agent_activity_log add column tool_calls_succeeded integer not null default 0;`);
  } catch {}
  try {
    execSql(`alter table agent_activity_log add column search_query_count integer not null default 0;`);
  } catch {}
  try {
    execSql(`alter table agent_activity_log add column source_count integer not null default 0;`);
  } catch {}
  try {
    execSql(`alter table agent_activity_log add column tool_failure_reason text;`);
  } catch {}
  try {
    execSql(`alter table new_research_tasks add column note_type text not null default '';`);
  } catch {
    // existing DBs may already include this column
  }
  try {
    execSql(`alter table new_research_tasks add column linked_note_file_id text not null default '';`);
  } catch {
    // existing DBs may already include this column
  }
  try {
    execSql(`alter table new_research_tasks add column linked_note_path text not null default '';`);
  } catch {
    // existing DBs may already include this column
  }
  try {
    execSql(`alter table new_research_tasks add column details text not null default '';`);
  } catch {
    // existing DBs may already include this column
  }
  try {
    execSql(`alter table new_research_tasks add column research_location_folder_id text not null default '';`);
  } catch {
    // existing DBs may already include this column
  }
  try {
    execSql(`alter table new_research_tasks add column research_location_path text not null default '';`);
  } catch {
    // existing DBs may already include this column
  }
  const noteTypeColumnInfo = queryJson<{ name: string; dflt_value: string | null }>(`pragma table_info('new_research_tasks')`)
    .find((column) => column.name === 'note_type' && column.dflt_value !== null && String(column.dflt_value).includes('Research'));
  if (noteTypeColumnInfo) {
    execSql(`
begin;
create table if not exists new_research_tasks_migrated (
  id text primary key,
  title text not null default '',
  details text not null default '',
  ticker text not null,
  note_type text not null default '',
  assignee text not null default '',
  priority text not null default '',
  deadline text not null default '',
  status text not null default 'ideas',
  date_completed text not null default '',
  archived integer not null default 0,
  linked_note_file_id text not null default '',
  linked_note_path text not null default '',
  research_location_folder_id text not null default '',
  research_location_path text not null default '',
  created_at text not null,
  updated_at text not null
);
insert into new_research_tasks_migrated (
  id, title, details, ticker, note_type, assignee, priority, deadline, status, date_completed, archived, linked_note_file_id, linked_note_path, research_location_folder_id, research_location_path, created_at, updated_at
)
select
  id, title, details, ticker, note_type, assignee, priority, deadline, status, date_completed, archived, linked_note_file_id, linked_note_path, research_location_folder_id, research_location_path, created_at, updated_at
from new_research_tasks;
drop table new_research_tasks;
alter table new_research_tasks_migrated rename to new_research_tasks;
commit;
`);
  }
  initialized = true;
};

const writeJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const beginNdjson = (res: ServerResponse) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
};

const writeNdjson = (res: ServerResponse, payload: Record<string, unknown>) => {
  res.write(`${JSON.stringify(payload)}\n`);
};

const readRawBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
};

const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const raw = (await readRawBody(req)).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
};

type MultipartUploadBody = {
  fields: Record<string, string>;
  file: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
  } | null;
};

const readMultipartUploadBody = async (req: IncomingMessage): Promise<MultipartUploadBody> => {
  const contentType = String(req.headers['content-type'] ?? '');
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? '').trim();
  if (!boundary) return { fields: {}, file: null };
  const raw = (await readRawBody(req)).toString('latin1');
  const segments = raw.split(`--${boundary}`);
  const fields: Record<string, string> = {};
  let file: MultipartUploadBody['file'] = null;
  for (const segment of segments) {
    if (!segment || segment === '--\r\n' || segment === '--') continue;
    const normalized = segment.startsWith('\r\n') ? segment.slice(2) : segment;
    const headerEndIndex = normalized.indexOf('\r\n\r\n');
    if (headerEndIndex < 0) continue;
    const headerBlock = normalized.slice(0, headerEndIndex);
    let bodyBlock = normalized.slice(headerEndIndex + 4);
    if (bodyBlock.endsWith('\r\n')) bodyBlock = bodyBlock.slice(0, -2);
    const dispositionLine = headerBlock.split('\r\n').find((line) => line.toLowerCase().startsWith('content-disposition:'));
    if (!dispositionLine) continue;
    const nameMatch = dispositionLine.match(/name="([^"]+)"/i);
    const filenameMatch = dispositionLine.match(/filename="([^"]*)"/i);
    const fieldName = nameMatch?.[1]?.trim();
    if (!fieldName) continue;
    const contentTypeLine = headerBlock.split('\r\n').find((line) => line.toLowerCase().startsWith('content-type:'));
    const partMimeType = contentTypeLine?.split(':', 2)[1]?.trim() || 'application/octet-stream';
    const partBuffer = Buffer.from(bodyBlock, 'latin1');
    if (filenameMatch && filenameMatch[1] !== undefined) {
      file = {
        filename: filenameMatch[1] || 'upload.bin',
        mimeType: partMimeType,
        buffer: partBuffer,
      };
      continue;
    }
    fields[fieldName] = partBuffer.toString('utf8');
  }
  return { fields, file };
};

function ensureWorkspaceWithStarterContent() {
  const existing = queryJson<WorkspaceRow>('select * from workspaces limit 1')[0];
  if (existing) return existing;

  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  const templatesFolderId = randomUUID();

  execSql(`
begin;
insert into workspaces (id, name, created_at, updated_at) values (${sqlEscape(workspaceId)}, 'Workspace', ${sqlEscape(now)}, ${sqlEscape(now)});
insert into folders (id, workspace_id, parent_id, name, path, created_at, updated_at) values (${sqlEscape(templatesFolderId)}, ${sqlEscape(workspaceId)}, NULL, 'Templates', 'Templates', ${sqlEscape(now)}, ${sqlEscape(now)});
commit;
`);

  return queryJson<WorkspaceRow>(`select * from workspaces where id = ${sqlEscape(workspaceId)} limit 1`)[0];
}

function listWorkspaceData(workspaceId: string) {
  const workspace = queryJson<{ id: string; name: string }>(`select id, name from workspaces where id = ${sqlEscape(workspaceId)} limit 1`)[0];
  const folders = queryJson<FolderRow>(`select * from folders where workspace_id = ${sqlEscape(workspaceId)} order by path`);
  const files = queryJson<ResearchNoteRow>(`select * from research_notes where workspace_id = ${sqlEscape(workspaceId)} order by path`).map((file) => ({
    ...file,
    is_template: Boolean(file.is_template),
    frontmatter_json: file.frontmatter_json ? JSON.parse(file.frontmatter_json) : null,
  }));
  return { workspace, folders, files };
}



function normalizeTaskRow(row: NewResearchTaskRow) {
  return {
    ...row,
    archived: Boolean(row.archived),
  };
}

const VALID_PROVIDERS: AgentProvider[] = ['minimax', 'openai', 'anthropic', 'ollama'];
const isAgentProvider = (value: unknown): value is AgentProvider => typeof value === 'string' && VALID_PROVIDERS.includes(value as AgentProvider);
const providerLabel = (provider: AgentProvider) => {
  if (provider === 'openai') return 'ChatGPT';
  if (provider === 'anthropic') return 'Claude';
  if (provider === 'ollama') return 'Ollama';
  return 'Minimax';
};

const OLLAMA_BASE_URL_DEFAULT = 'http://localhost:11434';

const WEB_SEARCH_PROVIDER_DEFAULT: WebSearchProvider = 'duckduckgo';
const WEB_SEARCH_MODE_DEFAULT: WebSearchMode = 'single';
const WEB_SEARCH_RECENCY_DEFAULT: WebSearchRecency = 'any';
const WEB_SEARCH_DOMAIN_POLICY_DEFAULT: WebSearchDomainPolicy = 'open_web';
const WEB_SEARCH_MAX_RESULTS_DEFAULT = 6;
const WEB_SEARCH_TIMEOUT_MS_DEFAULT = 10000;
const WEB_SEARCH_SAFE_SEARCH_DEFAULT = false;
const WEB_SEARCH_FAIL_OPEN_ON_TOOL_ERROR_DEFAULT = true;
const WEB_SEARCH_SEARXNG_BASE_URL_DEFAULT = 'http://localhost:8080';
const WEB_SEARCH_SEARXNG_USE_JSON_API_DEFAULT = true;
const AGENT_ACTIVITY_BUFFER_MAX = 1000;
const agentActivityBuffer: AgentActivityLogRow[] = [];

const isWebSearchProvider = (value: unknown): value is WebSearchProvider => value === 'duckduckgo' || value === 'searxng';
const isWebSearchMode = (value: unknown): value is WebSearchMode => value === 'single' || value === 'deep';
const isWebSearchRecency = (value: unknown): value is WebSearchRecency => value === 'any' || value === '7d' || value === '30d' || value === '365d';
const isWebSearchDomainPolicy = (value: unknown): value is WebSearchDomainPolicy => value === 'open_web' || value === 'prefer_list' || value === 'only_list';
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const normalizeEndpointUrl = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/\/+$/, '') || fallback;
};

const normalizeDomain = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  let domain = value.trim().toLowerCase();
  // Keep storage canonical for matching, even if UI later chooses to preserve raw input separately.
  domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  domain = domain.replace(/^\/\//, '');
  domain = domain.split(/[/?#]/, 1)[0] ?? '';
  domain = domain.replace(/:\d+$/, '');
  domain = domain.replace(/^(?:www\d*|m)\./, '');
  domain = domain.replace(/\.+$/, '');
  return domain;
};

const isValidDomain = (domain: string): boolean => DOMAIN_PATTERN.test(domain);

const parseOptionalWeight = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return Number.NaN;
  if (value < 1 || value > 100) return Number.NaN;
  return value;
};

const normalizePreferredSourceRow = (row: PreferredSourceRow) => ({
  ...row,
  enabled: Boolean(row.enabled),
});

const normalizeStreamingSources = (sources: SearchResult[]) => sources.map((source) => ({
  title: source.title,
  url: source.url,
  snippet: source.snippet,
  provider: source.provider,
  ...(source.published_at ? { published_at: source.published_at } : {}),
}));

const buildProviderGenerationParams = (
  provider: AgentProvider,
  payloadGenerationParams: unknown,
  ollamaRuntime: OllamaRuntimeConfig,
): { temperature?: number; maxTokens?: number; baseUrl?: string } => ({
  ...(payloadGenerationParams as { temperature?: number; maxTokens?: number } | undefined),
  ...(provider === 'ollama' ? { baseUrl: ollamaRuntime.baseUrl } : {}),
});

const invokeProviderGenerate = (
  provider: AgentProvider,
  request: {
    model: string;
    inputText: string;
    generationParams: { temperature?: number; maxTokens?: number; baseUrl?: string };
  },
  apiKey: string,
  signal: AbortSignal,
  options?: {
    onTextDelta?: (deltaText: string) => void;
  },
) => providerRegistry[provider].generate(request, apiKey, signal, options);

const parsePrefixedChatCommand = (
  inputText: string,
  prefixMap: ChatCommandPrefixMap,
): { command: ChatCommandName; remainder: string } | null => {
  const trimmed = inputText.trim();
  if (!trimmed) return null;
  const ordered = (Object.keys(prefixMap) as ChatCommandName[])
    .map((name) => ({ name, prefix: prefixMap[name].trim() }))
    .filter((entry) => entry.prefix.length > 0)
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const entry of ordered) {
    if (!trimmed.toLowerCase().startsWith(entry.prefix.toLowerCase())) continue;
    const remainder = trimmed.slice(entry.prefix.length).trim();
    return { command: entry.name, remainder };
  }
  return null;
};

const looksLikeNaturalLanguageToolRequest = (inputText: string): boolean => (
  /\b(create|update|archive|list|show|generate|draft)\b/i.test(inputText)
  && /\b(task|tasks|note|notes)\b/i.test(inputText)
);

const classifyChatIntent = (
  inputText: string,
  parsedCommand: { command: ChatCommandName; remainder: string } | null,
): { route: ChatIntentRoute; confidence: ChatIntentConfidence } => {
  if (parsedCommand?.command === 'task' || parsedCommand?.command === 'note') {
    return { route: 'action', confidence: 'high' };
  }
  const normalized = inputText.trim().toLowerCase();
  const hasActionVerb = /\b(create|update|archive|list|show|generate|draft|delete|remove|add)\b/.test(normalized);
  const hasActionEntity = /\b(task|tasks|note|notes)\b/.test(normalized);
  const hasQuestionSignal = /\?|\b(can you|could you|should i|what|which|how)\b/.test(normalized);
  if (hasActionVerb && hasActionEntity) {
    const specificIntent = /\b(for|about|with|named|called)\b/.test(normalized) || normalized.split(/\s+/).length >= 5;
    return { route: 'action', confidence: specificIntent ? 'high' : 'medium' };
  }
  if ((hasActionEntity && hasQuestionSignal) || (hasActionEntity && !hasActionVerb) || (hasActionVerb && !hasActionEntity)) {
    return { route: 'ambiguous', confidence: 'low' };
  }
  return { route: 'conversation', confidence: 'low' };
};

const buildActionClarificationQuestion = (prefixMap: ChatCommandPrefixMap, isPrefixModeOn: boolean): string => {
  if (isPrefixModeOn) {
    return [
      'I can help with that—do you want me to run an action or just answer conversationally?',
      `If action, use ${prefixMap.task} or ${prefixMap.note} and include what to do.`,
    ].join(' ');
  }
  return 'I can help with that—do you want me to run an action (task/note change) or just answer conversationally?';
};

const buildPrefixGuidanceMessage = (prefixMap: ChatCommandPrefixMap): string => [
  'Command prefix mode is enabled, so I can only execute tools through explicit commands.',
  `Try ${prefixMap.task} create task for NVDA, ${prefixMap.note} summarize task AAPL, ${prefixMap.confirm} to approve, or ${prefixMap.help} for the full list.`,
].join(' ');

type ParsedConfirmCommand = {
  is_confirm_command: boolean;
  is_plain_confirm: boolean;
  action?: 'archive' | 'overwrite';
  target_id?: string;
  malformed: boolean;
};

type PendingConfirmRequirement = {
  tier: 'A' | 'B' | 'C';
  action?: 'archive' | 'overwrite';
  target_id?: string;
  plain_confirm_allowed?: boolean;
  examples?: string[];
};

const parseConfirmCommand = (inputText: string): ParsedConfirmCommand => {
  const trimmed = inputText.trim();
  const match = trimmed.match(/^\/?confirm\b(.*)$/i);
  if (!match) {
    return {
      is_confirm_command: false,
      is_plain_confirm: false,
      malformed: false,
    };
  }
  const remainder = (match[1] ?? '').trim();
  if (!remainder) {
    return {
      is_confirm_command: true,
      is_plain_confirm: true,
      malformed: false,
    };
  }
  const structured = remainder.match(/^(archive|overwrite)\s+(\S+)$/i);
  if (!structured) {
    return {
      is_confirm_command: true,
      is_plain_confirm: false,
      malformed: true,
    };
  }
  const action = structured[1]?.toLowerCase() as 'archive' | 'overwrite';
  const targetId = structured[2];
  return {
    is_confirm_command: true,
    is_plain_confirm: false,
    action,
    target_id: targetId,
    malformed: false,
  };
};

const isSlashCancelCommand = (inputText: string): boolean => /^\/cancel\b/i.test(inputText.trim());

const extractExplicitConfirm = (
  parsedConfirm: ParsedConfirmCommand,
  payload: Record<string, unknown>,
): boolean => {
  if (typeof payload.explicit_confirm === 'boolean') return payload.explicit_confirm;
  return parsedConfirm.is_confirm_command;
};

const coercePendingConfirmRequirement = (draft: Record<string, unknown> | null): PendingConfirmRequirement => {
  const raw = draft?.confirm_requirement;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      tier: 'B',
      plain_confirm_allowed: true,
      examples: ['/confirm', 'confirm'],
    };
  }
  const record = raw as Record<string, unknown>;
  const tier = record.tier === 'A' || record.tier === 'B' || record.tier === 'C' ? record.tier : 'B';
  const action = record.action === 'archive' || record.action === 'overwrite' ? record.action : undefined;
  const targetId = typeof record.target_id === 'string' && record.target_id.trim() ? record.target_id.trim() : undefined;
  const examples = Array.isArray(record.examples)
    ? record.examples.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  return {
    tier,
    action,
    target_id: targetId,
    plain_confirm_allowed: typeof record.plain_confirm_allowed === 'boolean' ? record.plain_confirm_allowed : tier !== 'C',
    examples: examples.length ? examples : undefined,
  };
};

const buildMalformedConfirmationGuidance = (requirement: PendingConfirmRequirement): string => {
  const firstExample = requirement.examples?.[0] ?? '/confirm';
  if (requirement.tier === 'C') {
    return `I couldn't parse that confirmation. For this Tier C action, reply exactly with ${firstExample}.`;
  }
  return `I couldn't parse that confirmation. Reply with /confirm or confirm to proceed.`;
};

const validatePendingConfirmation = (
  requirement: PendingConfirmRequirement,
  parsedConfirm: ParsedConfirmCommand,
): { ok: true } | { ok: false; message: string } => {
  if (parsedConfirm.malformed) {
    return { ok: false, message: buildMalformedConfirmationGuidance(requirement) };
  }
  if (requirement.tier === 'C') {
    const expectedAction = requirement.action;
    const expectedTargetId = requirement.target_id;
    if (!parsedConfirm.is_confirm_command || parsedConfirm.is_plain_confirm) {
      const firstExample = requirement.examples?.[0] ?? '/confirm';
      return { ok: false, message: `This action is Tier C and needs target-specific confirmation. Reply with ${firstExample}.` };
    }
    if (!expectedAction || !expectedTargetId || parsedConfirm.action !== expectedAction || parsedConfirm.target_id !== expectedTargetId) {
      const firstExample = requirement.examples?.[0] ?? '/confirm';
      return { ok: false, message: `Confirmation target mismatch. To proceed, reply with ${firstExample}.` };
    }
    return { ok: true };
  }
  if (requirement.tier === 'B') {
    if (!parsedConfirm.is_confirm_command) {
      return { ok: false, message: 'This action is Tier B. Reply with /confirm or confirm to continue.' };
    }
    return { ok: true };
  }
  return { ok: true };
};

const parseDisambiguationChoice = (inputText: string): number | null => {
  const trimmed = inputText.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(?:option\s*)?(\d{1,2})$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const buildChatToolAdapter = (sessionId: string) => ({
  listTasks: async () => queryJson<NewResearchTaskRow>(
    'select * from new_research_tasks order by created_at desc',
  ).map((task) => {
    const normalized = normalizeTaskRow(task);
    return {
      id: normalized.id,
      title: normalized.title,
      ticker: normalized.ticker,
      note_type: normalized.note_type,
      status: normalized.status,
      archived: normalized.archived,
      linked_note_file_id: normalized.linked_note_file_id,
      linked_note_path: normalized.linked_note_path,
    };
  }),
  createTask: async (input: {
    ticker: string;
    title: string;
    note_type: string;
    details?: string;
    assignee?: string;
    priority?: string;
    deadline?: string;
    status?: 'ideas' | 'researching' | 'completed';
  }) => {
    const now = new Date().toISOString();
    const id = randomUUID();
    const ticker = input.ticker.trim().toUpperCase();
    const noteType = input.note_type.trim().toLowerCase();
    const priority = VALID_TASK_PRIORITIES.has(input.priority ?? '') ? (input.priority ?? '') : '';
    execSql(`insert into new_research_tasks (id, title, details, ticker, note_type, assignee, priority, deadline, status, date_completed, archived, linked_note_file_id, linked_note_path, research_location_folder_id, research_location_path, created_at, updated_at) values (${sqlEscape(id)}, ${sqlEscape(input.title)}, ${sqlEscape(input.details ?? '')}, ${sqlEscape(ticker)}, ${sqlEscape(noteType)}, ${sqlEscape(input.assignee ?? '')}, ${sqlEscape(priority)}, ${sqlEscape(input.deadline ?? '')}, ${sqlEscape(input.status ?? 'ideas')}, '', 0, '', '', '', '', ${sqlEscape(now)}, ${sqlEscape(now)})`);
    recordTaskEvent(id, 'create', `Task created via chat orchestration (${ticker} — ${input.title}).`);
    const created = queryJson<NewResearchTaskRow>(`select * from new_research_tasks where id = ${sqlEscape(id)} limit 1`)[0];
    const normalized = normalizeTaskRow(created);
    return {
      id: normalized.id,
      title: normalized.title,
      ticker: normalized.ticker,
      note_type: normalized.note_type,
      status: normalized.status,
      archived: normalized.archived,
      linked_note_file_id: normalized.linked_note_file_id,
      linked_note_path: normalized.linked_note_path,
    };
  },
  updateTask: async (taskId: string, patch: Record<string, unknown>) => {
    const existing = queryJson<NewResearchTaskRow>(`select * from new_research_tasks where id = ${sqlEscape(taskId)} limit 1`)[0];
    if (!existing) throw new Error('Task not found.');
    const now = new Date().toISOString();
    const nextTicker = typeof patch.ticker === 'string' ? patch.ticker.trim().toUpperCase() : existing.ticker;
    const nextNoteType = typeof patch.note_type === 'string' ? patch.note_type.trim().toLowerCase() : existing.note_type;
    const nextPriorityCandidate = typeof patch.priority === 'string' ? patch.priority.trim().toLowerCase() : existing.priority;
    const nextPriority = VALID_TASK_PRIORITIES.has(nextPriorityCandidate) ? nextPriorityCandidate : existing.priority;
    const nextStatus = patch.status === 'ideas' || patch.status === 'researching' || patch.status === 'completed'
      ? patch.status
      : existing.status;
    const nextArchived = typeof patch.archived === 'boolean' ? patch.archived : Boolean(existing.archived);
    execSql(`update new_research_tasks set
      title = ${sqlEscape(typeof patch.title === 'string' ? patch.title : existing.title)},
      details = ${sqlEscape(typeof patch.details === 'string' ? patch.details : existing.details)},
      ticker = ${sqlEscape(nextTicker)},
      note_type = ${sqlEscape(nextNoteType)},
      assignee = ${sqlEscape(typeof patch.assignee === 'string' ? patch.assignee : existing.assignee)},
      priority = ${sqlEscape(nextPriority)},
      deadline = ${sqlEscape(typeof patch.deadline === 'string' ? patch.deadline : existing.deadline)},
      status = ${sqlEscape(nextStatus)},
      archived = ${sqlEscape(nextArchived ? 1 : 0)},
      updated_at = ${sqlEscape(now)}
      where id = ${sqlEscape(taskId)}`);
    const updated = queryJson<NewResearchTaskRow>(`select * from new_research_tasks where id = ${sqlEscape(taskId)} limit 1`)[0];
    const normalized = normalizeTaskRow(updated);
    recordTaskEvent(taskId, 'edit', 'Task updated via chat orchestration.');
    return {
      id: normalized.id,
      title: normalized.title,
      ticker: normalized.ticker,
      note_type: normalized.note_type,
      status: normalized.status,
      archived: normalized.archived,
      linked_note_file_id: normalized.linked_note_file_id,
      linked_note_path: normalized.linked_note_path,
    };
  },
  generateNote: async (input: { instruction: string; taskId?: string; noteId?: string; title?: string }) => {
    const now = new Date().toISOString();
    if (input.noteId) {
      const existing = queryJson<ResearchNoteRow>(`select * from research_notes where id = ${sqlEscape(input.noteId)} limit 1`)[0];
      if (!existing) throw new Error('Note not found.');
      const nextContent = [existing.content || '', '', `## Chat instruction`, input.instruction].join('\n').trim();
      execSql(`update research_notes set content = ${sqlEscape(nextContent)}, updated_at = ${sqlEscape(now)} where id = ${sqlEscape(existing.id)}`);
      return { note_id: existing.id, action: 'updated' as const };
    }
    const workspace = ensureWorkspaceWithStarterContent();
    const noteId = randomUUID();
    const inferredTitle = (input.title?.trim() || `Chat Draft ${new Date().toISOString().slice(0, 10)}`);
    const safeTitle = inferredTitle.replace(/[\\/:*?"<>|]/g, '').trim() || 'Chat Draft';
    const notePath = `${safeTitle}.md`;
    execSql(`insert into research_notes (id, workspace_id, folder_id, name, path, content, frontmatter_json, is_template, created_at, updated_at) values (${sqlEscape(noteId)}, ${sqlEscape(workspace.id)}, NULL, ${sqlEscape(safeTitle)}, ${sqlEscape(notePath)}, ${sqlEscape(`# ${safeTitle}\n\n${input.instruction}`)}, NULL, 0, ${sqlEscape(now)}, ${sqlEscape(now)})`);
    if (input.taskId) {
      execSql(`update new_research_tasks set linked_note_file_id = ${sqlEscape(noteId)}, linked_note_path = ${sqlEscape(notePath)}, updated_at = ${sqlEscape(now)} where id = ${sqlEscape(input.taskId)}`);
      recordTaskEvent(input.taskId, 'link', `Linked generated note via chat orchestration: ${notePath}.`);
    }
    return { note_id: noteId, action: 'created' as const };
  },
  savePendingActionDraft: async (targetSessionId: string, actionKey: string, draft: Record<string, unknown>, status?: 'pending' | 'confirmed' | 'cancelled') => {
    savePendingActionDraft(targetSessionId, actionKey, draft, status ?? 'pending');
  },
});

const normalizeAgentGenerationParams = (raw: unknown): AgentGenerationParams => {
  if (!raw || typeof raw !== 'object') return null;
  const next = raw as Record<string, unknown>;
  const localConnection = next.local_connection && typeof next.local_connection === 'object'
    ? (next.local_connection as Record<string, unknown>)
    : null;
  const webSearch = next.web_search && typeof next.web_search === 'object'
    ? (next.web_search as Record<string, unknown>)
    : null;
  const webSearchProviderConfig = webSearch?.provider_config && typeof webSearch.provider_config === 'object'
    ? (webSearch.provider_config as Record<string, unknown>)
    : null;
  const searxngConfig = webSearchProviderConfig?.searxng && typeof webSearchProviderConfig.searxng === 'object'
    ? (webSearchProviderConfig.searxng as Record<string, unknown>)
    : null;
  return {
    temperature: typeof next.temperature === 'number' ? next.temperature : undefined,
    maxTokens: typeof next.maxTokens === 'number' ? next.maxTokens : undefined,
    local_connection: localConnection ? {
      base_url: normalizeEndpointUrl(localConnection.base_url, OLLAMA_BASE_URL_DEFAULT),
      model: typeof localConnection.model === 'string' ? localConnection.model.trim() : '',
      B: typeof localConnection.B === 'number' && Number.isFinite(localConnection.B) ? localConnection.B : 1,
    } : {
      base_url: OLLAMA_BASE_URL_DEFAULT,
      model: '',
      B: 1,
    },
    web_search: {
      enabled: typeof webSearch?.enabled === 'boolean' ? webSearch.enabled : false,
      fail_open_on_tool_error: typeof webSearch?.fail_open_on_tool_error === 'boolean'
        ? webSearch.fail_open_on_tool_error
        : WEB_SEARCH_FAIL_OPEN_ON_TOOL_ERROR_DEFAULT,
      provider: isWebSearchProvider(webSearch?.provider) ? webSearch.provider : WEB_SEARCH_PROVIDER_DEFAULT,
      mode: isWebSearchMode(webSearch?.mode) ? webSearch.mode : WEB_SEARCH_MODE_DEFAULT,
      max_results: typeof webSearch?.max_results === 'number' && Number.isFinite(webSearch.max_results)
        ? Math.max(1, Math.floor(webSearch.max_results))
        : WEB_SEARCH_MAX_RESULTS_DEFAULT,
      timeout_ms: typeof webSearch?.timeout_ms === 'number' && Number.isFinite(webSearch.timeout_ms)
        ? Math.max(1, Math.floor(webSearch.timeout_ms))
        : WEB_SEARCH_TIMEOUT_MS_DEFAULT,
      safe_search: typeof webSearch?.safe_search === 'boolean' ? webSearch.safe_search : WEB_SEARCH_SAFE_SEARCH_DEFAULT,
      recency: isWebSearchRecency(webSearch?.recency) ? webSearch.recency : WEB_SEARCH_RECENCY_DEFAULT,
      domain_policy: isWebSearchDomainPolicy(webSearch?.domain_policy) ? webSearch.domain_policy : WEB_SEARCH_DOMAIN_POLICY_DEFAULT,
      source_citation: typeof webSearch?.source_citation === 'boolean' ? webSearch.source_citation : false,
      provider_config: {
        searxng: {
          base_url: normalizeEndpointUrl(searxngConfig?.base_url, WEB_SEARCH_SEARXNG_BASE_URL_DEFAULT),
          use_json_api: typeof searxngConfig?.use_json_api === 'boolean'
            ? searxngConfig.use_json_api
            : WEB_SEARCH_SEARXNG_USE_JSON_API_DEFAULT,
        },
      },
    },
  };
};

const resolveOllamaRuntimeConfig = (settings: { default_provider: AgentProvider; default_model: string; generation_params?: AgentGenerationParams }): OllamaRuntimeConfig => {
  const baseUrl = normalizeEndpointUrl(settings.generation_params?.local_connection?.base_url, OLLAMA_BASE_URL_DEFAULT);
  const localModel = settings.generation_params?.local_connection?.model?.trim() || '';
  const defaultModel = settings.default_provider === 'ollama' && !localModel ? settings.default_model.trim() : '';
  return {
    baseUrl,
    model: localModel || defaultModel,
  };
};

const getAgentSettings = () => {
  const settings = queryJson<AgentSettingsRow>('select default_provider, default_model, generation_params_json from agent_settings where id = 1 limit 1')[0];
  const provider = isAgentProvider(settings?.default_provider) ? settings.default_provider : 'minimax';
  const generationParams = normalizeAgentGenerationParams(settings?.generation_params_json ? JSON.parse(settings.generation_params_json) : null);
  const nextSettings = {
    default_provider: provider,
    default_model: settings?.default_model ?? '',
    generation_params: generationParams,
  };
  const ollamaRuntime = resolveOllamaRuntimeConfig(nextSettings);
  if (nextSettings.generation_params?.local_connection) {
    nextSettings.generation_params.local_connection.base_url = ollamaRuntime.baseUrl;
    nextSettings.generation_params.local_connection.model = ollamaRuntime.model;
  }
  if (nextSettings.default_provider === 'ollama') {
    nextSettings.default_model = ollamaRuntime.model;
  }
  return nextSettings;
};

const appendAgentActivityLog = (entry: Omit<AgentActivityLogRow, 'id'>) => {
  agentActivityBuffer.push({ id: randomUUID(), ...entry });
  if (agentActivityBuffer.length > AGENT_ACTIVITY_BUFFER_MAX) {
    agentActivityBuffer.splice(0, agentActivityBuffer.length - AGENT_ACTIVITY_BUFFER_MAX);
  }
};

const getAttachmentSettings = () => {
  const row = queryJson<AttachmentSettingsRow>('select id, quota_mb, retention_days from attachment_settings where id = 1 limit 1')[0];
  return {
    quota_mb: Number(row?.quota_mb ?? DEFAULT_ATTACHMENT_QUOTA_MB),
    retention_days: Number(row?.retention_days ?? DEFAULT_ATTACHMENT_RETENTION_DAYS),
  };
};

const getAttachmentUsage = () => {
  const usage = queryJson<{ usage_bytes: number }>('select coalesce(sum(size_bytes), 0) as usage_bytes from attachments where deleted_at is null')[0];
  const reclaimable = queryJson<{ reclaimable_bytes: number }>('select coalesce(sum(size_bytes), 0) as reclaimable_bytes from attachments where deleted_at is not null')[0];
  return {
    usage_bytes: Number(usage?.usage_bytes ?? 0),
    reclaimable_bytes: Number(reclaimable?.reclaimable_bytes ?? 0),
  };
};

const runAttachmentCleanup = () => {
  const { retention_days } = getAttachmentSettings();
  const cutoff = new Date(Date.now() - retention_days * 24 * 60 * 60 * 1000).toISOString();
  const expired = queryJson<AttachmentRow>(`select * from attachments where deleted_at is not null and deleted_at <= ${sqlEscape(cutoff)}`);
  let removedFiles = 0;
  expired.forEach((attachment) => {
    const filePath = path.resolve(attachmentsRootPath, attachment.storage_relpath);
    try {
      if (statSync(filePath).isFile()) {
        unlinkSync(filePath);
        removedFiles += 1;
      }
    } catch {}
  });
  if (expired.length > 0) {
    const ids = expired.map((attachment) => sqlEscape(attachment.id)).join(', ');
    execSql(`delete from attachment_links where attachment_id in (${ids}); delete from attachments where id in (${ids});`);
  }

  const knownPaths = new Set(queryJson<Pick<AttachmentRow, 'storage_relpath'>>('select storage_relpath from attachments').map((row) => row.storage_relpath));
  const walk = (dirPath: string): string[] => {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const resolved = path.join(dirPath, entry.name);
      if (entry.isDirectory()) return walk(resolved);
      return [resolved];
    });
  };
  const files = walk(attachmentsRootPath).filter((filePath) => !filePath.includes(`${path.sep}.tmp${path.sep}`));
  files.forEach((filePath) => {
    const relpath = path.relative(attachmentsRootPath, filePath).split(path.sep).join('/');
    if (!knownPaths.has(relpath)) {
      rmSync(filePath, { force: true });
      removedFiles += 1;
    }
  });
  return { removed_files: removedFiles, purged_attachments: expired.length };
};

export async function handleLocalApiRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '';
  ensureInitialized();

  if (req.method === 'GET' && url === '/api/bootstrap') {
    const workspace = ensureWorkspaceWithStarterContent();
    writeJson(res, 200, listWorkspaceData(workspace.id));
    return true;
  }

  try {
    if (req.method === 'GET' && url === '/api/chat/session/current') {
      const session = getOrCreatePrimaryChatSession(DEFAULT_CHAT_USER_ID);
      writeJson(res, 200, session);
      return true;
    }

    if (req.method === 'GET' && url.startsWith('/api/chat/session/current/messages')) {
      const session = getOrCreatePrimaryChatSession(DEFAULT_CHAT_USER_ID);
      const parsedUrl = new URL(url, 'http://localhost');
      const limit = Number.parseInt(parsedUrl.searchParams.get('limit') ?? '50', 10);
      const before = parsedUrl.searchParams.get('before') ?? undefined;
      const messages = loadPaginatedChatMessages(session.id, Number.isFinite(limit) ? limit : 50, before).map((row) => ({
        ...row,
        stream: parseJsonOrNull<Record<string, unknown>>(row.stream_json),
        metadata: parseJsonOrNull<Record<string, unknown>>(row.metadata_json),
      }));
      writeJson(res, 200, { session, messages });
      return true;
    }

    if (req.method === 'POST' && url === '/api/chat/session/current/messages') {
      const payload = await readJsonBody(req);
      const inputText = String(payload.content ?? payload.input_text ?? '').trim();
      if (!inputText) {
        writeJson(res, 400, { error: { message: 'content is required.' } });
        return true;
      }
      const settings = getAgentSettings();
      const preferred = isAgentProvider(payload.provider) ? payload.provider : settings.default_provider;
      const modelFromPayload = String(payload.model ?? '').trim();
      const ollamaRuntime = resolveOllamaRuntimeConfig(settings);
      const fallbackModelId = FALLBACK_MODELS[preferred][0]?.modelId ?? '';
      const resolvedModel = preferred === 'ollama'
        ? ollamaRuntime.model
        : (modelFromPayload || settings.default_model || fallbackModelId);
      if (!resolvedModel) {
        writeJson(res, 400, { error: { message: 'Model is required.' } });
        return true;
      }
      const apiKey = secretStore.get(preferred);
      if (preferred !== 'ollama' && !apiKey) {
        writeJson(res, 400, { error: { message: 'Missing API key for selected provider.' } });
        return true;
      }
      const session = getOrCreatePrimaryChatSession(DEFAULT_CHAT_USER_ID);
      const settingsRow = getOrCreateChatSettings(DEFAULT_CHAT_USER_ID);
      const policy = coerceChatContextPolicy(parseJsonOrNull<Record<string, unknown>>(settingsRow.policy_json));
      const normalizedPolicy = normalizeChatSettingsPolicy(parseJsonOrNull<Record<string, unknown>>(settingsRow.policy_json));
      const actionMode = normalizedPolicy.actionMode;
      const commandPrefixMode = normalizedPolicy.commandPrefixMode;
      const commandPrefixMap = normalizedPolicy.commandPrefixMap;
      const parsedPrefixedCommand = parsePrefixedChatCommand(inputText, commandPrefixMap);
      if (normalizedPolicy.warningCode) {
        emitStructuredLog('chat.action_mode.warning', {
          code: normalizedPolicy.warningCode,
          raw_value: normalizedPolicy.normalizedFrom,
          fallback_mode: actionMode,
          session_id: session.id,
          path: '/api/chat/session/current/messages',
        });
      }
      const profile = parseJsonOrNull<Record<string, unknown>>(settingsRow.profile_json);
      const snapshot = loadMemorySnapshot(session.id);
      const recentMessages = loadPaginatedChatMessages(session.id, policy.max_context_messages);
      const contextPayload = buildChatContextInput({
        inputText,
        recentMessages,
        snapshot,
        policy,
        profile,
      });
      const turnCorrelationId = randomUUID();
      const turnStartedAt = Date.now();
      const controller = new AbortController();
      let clientAborted = false;
      req.on('aborted', () => {
        clientAborted = true;
        controller.abort();
      });
      const streamEvents: Array<Record<string, unknown>> = [{
        type: 'status',
        stage: 'started',
        correlation: {
          turn_id: turnCorrelationId,
          session_id: session.id,
        },
      }];
      let assistantText = '';
      let persisted = false;
      beginNdjson(res);
      writeNdjson(res, {
        type: 'status',
        stage: 'started',
        correlation: { turn_id: turnCorrelationId, session_id: session.id },
        context: contextPayload.meta,
      });
      emitStructuredLog('chat.turn.started', {
        correlation_id: turnCorrelationId,
        session_id: session.id,
        provider: preferred,
        model: resolvedModel,
        tool_attempts: 0,
      });
      try {
        const parsedConfirmCommand = parseConfirmCommand(inputText);
        let explicitConfirm = extractExplicitConfirm(parsedConfirmCommand, payload as Record<string, unknown>);
        if (!explicitConfirm && parsedPrefixedCommand?.command === 'confirm') explicitConfirm = true;
        const normalizedInputText = parsedPrefixedCommand?.remainder || inputText;
        const isPrefixModeOn = commandPrefixMode === 'on';
        const intentRouting = classifyChatIntent(normalizedInputText, parsedPrefixedCommand);
        const shouldBlockNlToolExecution = isPrefixModeOn && !parsedPrefixedCommand && looksLikeNaturalLanguageToolRequest(inputText);
        if (isPrefixModeOn && parsedPrefixedCommand?.command === 'help') {
          const helpText = [
            'Command prefix mode is enabled.',
            `Active commands: ${Object.entries(commandPrefixMap).map(([name, prefix]) => `${prefix} (${name})`).join(', ')}.`,
            `Examples: ${commandPrefixMap.task} create task for AAPL | ${commandPrefixMap.note} draft earnings note for AAPL | ${commandPrefixMap.confirm} | ${commandPrefixMap.cancel}.`,
          ].join(' ');
          const doneFrame = { type: 'done', outputText: helpText, latencyMs: Date.now() - turnStartedAt };
          streamEvents.push(doneFrame);
          writeNdjson(res, doneFrame);
          persistChatTurnAtomic({
            sessionId: session.id,
            userContent: inputText,
            assistantContent: helpText,
            provider: preferred,
            model: resolvedModel,
            stream: { events: streamEvents, status: 'done' },
            metadata: { usage: null, costEstimate: null, completedAt: new Date().toISOString(), correlation: { turn_id: turnCorrelationId, session_id: session.id }, context: contextPayload.meta },
          });
          persisted = true;
          res.end();
          return true;
        }
        const expiredPendingCount = cancelExpiredPendingActionDrafts(session.id);
        const isCancelCommand = (isPrefixModeOn && parsedPrefixedCommand?.command === 'cancel') || isSlashCancelCommand(inputText);
        if (isCancelCommand) {
          const cancelledCount = cancelAllPendingActionDrafts(session.id);
          const cancelledText = cancelledCount > 0
            ? `Okay — cancelled ${cancelledCount === 1 ? 'the pending action draft' : `${cancelledCount} pending action drafts`}.`
            : 'There are no pending action drafts to cancel.';
          const doneFrame = { type: 'done', outputText: cancelledText, latencyMs: Date.now() - turnStartedAt };
          streamEvents.push(doneFrame);
          writeNdjson(res, doneFrame);
          persistChatTurnAtomic({
            sessionId: session.id,
            userContent: inputText,
            assistantContent: cancelledText,
            provider: preferred,
            model: resolvedModel,
            stream: { events: streamEvents, status: 'done' },
            metadata: { usage: null, costEstimate: null, completedAt: new Date().toISOString(), correlation: { turn_id: turnCorrelationId, session_id: session.id }, context: contextPayload.meta },
          });
          persisted = true;
          res.end();
          return true;
        }
        if (shouldBlockNlToolExecution) {
          const guidanceText = buildPrefixGuidanceMessage(commandPrefixMap);
          const doneFrame = { type: 'done', outputText: guidanceText, latencyMs: Date.now() - turnStartedAt };
          streamEvents.push(doneFrame);
          writeNdjson(res, doneFrame);
          persistChatTurnAtomic({
            sessionId: session.id,
            userContent: inputText,
            assistantContent: guidanceText,
            provider: preferred,
            model: resolvedModel,
            stream: { events: streamEvents, status: 'done' },
            metadata: { usage: null, costEstimate: null, completedAt: new Date().toISOString(), correlation: { turn_id: turnCorrelationId, session_id: session.id }, context: contextPayload.meta, command_prefix_mode: 'blocked_nl_tool_execution' },
          });
          persisted = true;
          res.end();
          return true;
        }
        const pendingToolDraft = loadLatestPendingChatToolDraft(session.id);
        if (!pendingToolDraft?.draft && explicitConfirm && expiredPendingCount > 0) {
          const expiredText = `Your pending draft expired after ${Math.floor(pendingActionTtlMs / 60000)} minutes and was cancelled. Please recreate the action draft, then confirm again.`;
          const doneFrame = { type: 'done', outputText: expiredText, latencyMs: Date.now() - turnStartedAt };
          streamEvents.push(doneFrame);
          writeNdjson(res, doneFrame);
          persistChatTurnAtomic({
            sessionId: session.id,
            userContent: inputText,
            assistantContent: expiredText,
            provider: preferred,
            model: resolvedModel,
            stream: { events: streamEvents, status: 'done' },
            metadata: {
              usage: null,
              costEstimate: null,
              completedAt: new Date().toISOString(),
              correlation: { turn_id: turnCorrelationId, session_id: session.id },
              context: contextPayload.meta,
              pending_action: {
                expired: true,
                expired_count: expiredPendingCount,
                ttl_minutes: Math.floor(pendingActionTtlMs / 60000),
              },
            },
          });
          persisted = true;
          res.end();
          return true;
        }
        const disambiguationChoice = parseDisambiguationChoice(normalizedInputText);
        const pendingRequirement = pendingToolDraft?.draft ? coercePendingConfirmRequirement(pendingToolDraft.draft) : null;
        if (!explicitConfirm && pendingToolDraft?.draft && disambiguationChoice !== null && pendingRequirement?.tier !== 'C') {
          explicitConfirm = true;
        }
        let toolCallsAttempted = 0;
        let toolCallsSucceeded = 0;
        let toolNarrationBefore = '';
        let toolNarrationAfter = '';
        let toolMetadata: Record<string, unknown> | null = null;
        let generationPrompt = contextPayload.prompt;
        if (pendingToolDraft?.draft && actionMode !== 'manual_only' && explicitConfirm) {
          const confirmationValidation = validatePendingConfirmation(pendingRequirement ?? { tier: 'B', plain_confirm_allowed: true }, parsedConfirmCommand);
          if (!confirmationValidation.ok) {
            const confirmationMessage = 'message' in confirmationValidation ? confirmationValidation.message : 'Confirmation is required before I can continue.';
            const doneFrame = {
              type: 'done',
              outputText: confirmationMessage,
              latencyMs: Date.now() - turnStartedAt,
            };
            streamEvents.push(doneFrame);
            writeNdjson(res, doneFrame);
            persistChatTurnAtomic({
              sessionId: session.id,
              userContent: inputText,
              assistantContent: confirmationMessage,
              provider: preferred,
              model: resolvedModel,
              stream: { events: streamEvents, status: 'done' },
              metadata: {
                usage: null,
                costEstimate: null,
                completedAt: new Date().toISOString(),
                correlation: { turn_id: turnCorrelationId, session_id: session.id },
                context: contextPayload.meta,
                confirmation_validation: {
                  ok: false,
                  tier: (pendingRequirement ?? { tier: 'B' as const }).tier,
                  expected: pendingRequirement?.examples?.[0] ?? null,
                },
              },
            });
            persisted = true;
            res.end();
            return true;
          }
          const draftToolName = typeof pendingToolDraft.draft.tool_name === 'string' ? pendingToolDraft.draft.tool_name : '';
          const draftArguments = pendingToolDraft.draft.arguments && typeof pendingToolDraft.draft.arguments === 'object'
            ? { ...(pendingToolDraft.draft.arguments as Record<string, unknown>) }
            : {};
          const payloadToolArguments = payload.tool_arguments && typeof payload.tool_arguments === 'object'
            ? (payload.tool_arguments as Record<string, unknown>)
            : null;
          const mergedArguments = payloadToolArguments ? { ...draftArguments, ...payloadToolArguments } : draftArguments;
          if (disambiguationChoice !== null) {
            const ambiguousMatches = Array.isArray(pendingToolDraft.draft.ambiguous_matches)
              ? pendingToolDraft.draft.ambiguous_matches as Array<Record<string, unknown>>
              : [];
            const selected = ambiguousMatches[disambiguationChoice - 1];
            if (selected?.id && typeof selected.id === 'string') {
              mergedArguments.task_id = selected.id;
              if (!payloadToolArguments?.task_ref) delete mergedArguments.task_ref;
            }
          }
          if (isSupportedChatTool(draftToolName)) {
            toolCallsAttempted = 1;
            const startFrame = {
              type: 'tool_call_started',
              tool_call_id: `pending-${pendingToolDraft.id}`,
              tool_name: draftToolName,
              arguments: mergedArguments,
              resumed_from_pending: true,
            };
            streamEvents.push(startFrame);
            writeNdjson(res, startFrame);
            const adapter = buildChatToolAdapter(session.id);
            const outcome = await runChatToolOrchestration(adapter, {
              sessionId: session.id,
              toolCall: {
                id: `pending-${pendingToolDraft.id}`,
                name: draftToolName,
                arguments: mergedArguments,
              },
              explicitConfirm: true,
            });
            if (outcome.status === 'executed') {
              toolCallsSucceeded = 1;
              savePendingActionDraft(session.id, pendingToolDraft.action_key, pendingToolDraft.draft, 'confirmed');
            }
            toolNarrationBefore = outcome.narration_before;
            toolNarrationAfter = outcome.narration_after;
            toolMetadata = {
              tool_outcome: outcome.status,
              resumed_from_pending: true,
              pending_action_id: pendingToolDraft.id,
              missing_fields: outcome.missing_fields ?? null,
              disambiguation_prompt: outcome.disambiguation_prompt ?? null,
              result: outcome.result ?? null,
              explicit_confirm: explicitConfirm,
            };
            const resultFrame = {
              type: 'tool_call_result',
              tool_call_id: `pending-${pendingToolDraft.id}`,
              tool_name: draftToolName,
              outcome: outcome.status,
              narration_before: outcome.narration_before,
              narration_after: outcome.narration_after,
              missing_fields: outcome.missing_fields,
              disambiguation_prompt: outcome.disambiguation_prompt,
              result: outcome.result,
              resumed_from_pending: true,
            };
            streamEvents.push(resultFrame);
            writeNdjson(res, resultFrame);
            if (outcome.status === 'needs_confirmation' || outcome.status === 'needs_disambiguation' || outcome.status === 'rejected') {
              const toolOnlyText = [
                outcome.narration_before,
                outcome.disambiguation_prompt,
                outcome.narration_after,
              ].filter(Boolean).join('\n\n');
              const doneFrame = { type: 'done', outputText: toolOnlyText, latencyMs: Date.now() - turnStartedAt };
              streamEvents.push(doneFrame);
              writeNdjson(res, doneFrame);
              const persistedIds = persistChatTurnAtomic({
                sessionId: session.id,
                userContent: inputText,
                assistantContent: toolOnlyText,
                provider: preferred,
                model: resolvedModel,
                stream: { events: streamEvents, status: 'done' },
                metadata: {
                  usage: null,
                  costEstimate: null,
                  completedAt: new Date().toISOString(),
                  correlation: { turn_id: turnCorrelationId, session_id: session.id },
                  context: contextPayload.meta,
                  tool: toolMetadata,
                  metrics: {
                    turn_latency_ms: Date.now() - turnStartedAt,
                    tool_attempts: toolCallsAttempted,
                    tool_successes: toolCallsSucceeded,
                    tool_failures: Math.max(0, toolCallsAttempted - toolCallsSucceeded),
                  },
                },
              });
              emitStructuredLog('chat.turn.completed', {
                correlation_id: turnCorrelationId,
                session_id: session.id,
                message_id: persistedIds.assistantMessageId,
                turn_latency_ms: Date.now() - turnStartedAt,
                stream_status: 'done',
                tool_attempts: toolCallsAttempted,
                tool_successes: toolCallsSucceeded,
                tool_failures: Math.max(0, toolCallsAttempted - toolCallsSucceeded),
              });
              persisted = true;
              res.end();
              return true;
            }
            generationPrompt = [
              contextPayload.prompt,
              '',
              '[TOOL_ORCHESTRATION]',
              toolNarrationBefore,
              toolNarrationAfter,
              `Tool result JSON: ${JSON.stringify(outcome.result ?? {})}`,
            ].filter(Boolean).join('\n');
          }
        } else if (
          actionMode !== 'manual_only'
          && supportsToolCalling(preferred, resolvedModel)
          && (!isPrefixModeOn || Boolean(parsedPrefixedCommand))
        ) {
          if (intentRouting.route === 'ambiguous') {
            const clarificationText = buildActionClarificationQuestion(commandPrefixMap, isPrefixModeOn);
            const routeFrame = {
              type: 'intent_routing',
              route: intentRouting.route,
              confidence: intentRouting.confidence,
            };
            streamEvents.push(routeFrame);
            writeNdjson(res, routeFrame);
            const doneFrame = { type: 'done', outputText: clarificationText, latencyMs: Date.now() - turnStartedAt };
            streamEvents.push(doneFrame);
            writeNdjson(res, doneFrame);
            persistChatTurnAtomic({
              sessionId: session.id,
              userContent: inputText,
              assistantContent: clarificationText,
              provider: preferred,
              model: resolvedModel,
              stream: { events: streamEvents, status: 'done' },
              metadata: {
                usage: null,
                costEstimate: null,
                completedAt: new Date().toISOString(),
                correlation: { turn_id: turnCorrelationId, session_id: session.id },
                context: contextPayload.meta,
                intent_routing: routeFrame,
              },
            });
            persisted = true;
            res.end();
            return true;
          }
          const shouldRunToolPlanning = intentRouting.route === 'action'
            && (intentRouting.confidence === 'medium' || intentRouting.confidence === 'high');
          if (!shouldRunToolPlanning) {
            const routeFrame = {
              type: 'intent_routing',
              route: intentRouting.route,
              confidence: intentRouting.confidence,
            };
            streamEvents.push(routeFrame);
            writeNdjson(res, routeFrame);
          }
          if (shouldRunToolPlanning) {
          try {
            const routeFrame = {
              type: 'intent_routing',
              route: intentRouting.route,
              confidence: intentRouting.confidence,
            };
            streamEvents.push(routeFrame);
            writeNdjson(res, routeFrame);
            const planningStart = { type: 'tool_planning_started', tool_count: CHAT_TOOLS.length };
            streamEvents.push(planningStart);
            writeNdjson(res, planningStart);
            const planning = await providerRegistry[preferred].generateToolFirstTurn({
              model: resolvedModel,
              inputText: [
                parsedPrefixedCommand ? `[PREFIX_COMMAND]\n${parsedPrefixedCommand.command}` : '',
                contextPayload.prompt.replace(inputText, normalizedInputText),
              ].filter(Boolean).join('\n\n'),
              tools: CHAT_TOOLS as unknown as AgentToolDefinition[],
              generationParams: {
                ...(payload.generation_params as { temperature?: number; maxTokens?: number } | undefined),
                ...(preferred === 'ollama' ? { baseUrl: ollamaRuntime.baseUrl } : {}),
              },
            }, apiKey ?? '', controller.signal);
            const planFrame = {
              type: 'tool_planning_result',
              planned_tool_calls: planning.toolCalls.map((call) => ({ id: call.id, name: call.name })),
              message: planning.toolCalls.length > 0
                ? `Planned ${planning.toolCalls.length} tool call${planning.toolCalls.length === 1 ? '' : 's'}.`
                : 'No tool calls planned.',
            };
            streamEvents.push(planFrame);
            writeNdjson(res, planFrame);
            const supportedCall = planning.toolCalls.find((call) => isSupportedChatTool(call.name));
            if (supportedCall) {
            if (actionMode === 'confirm_required' && !explicitConfirm) {
              const actionKey = `chat_tool:${supportedCall.name}`;
              savePendingActionDraft(session.id, actionKey, {
                tool_name: supportedCall.name,
                arguments: supportedCall.arguments,
                requires_explicit_confirm: true,
              }, 'pending');
              const confirmFrame = {
                type: 'tool_call_result',
                tool_call_id: supportedCall.id,
                tool_name: supportedCall.name,
                outcome: 'needs_confirmation',
                narration_before: 'I prepared the action request.',
                narration_after: 'Explicit confirmation is required in current mode. Reply with confirmation to execute.',
              };
              streamEvents.push(confirmFrame);
              writeNdjson(res, confirmFrame);
              const doneFrame = {
                type: 'done',
                outputText: 'I prepared the action request. Explicit confirmation is required in current mode. Reply with confirmation to execute.',
                latencyMs: Date.now() - turnStartedAt,
              };
              streamEvents.push(doneFrame);
              writeNdjson(res, doneFrame);
              const persistedIds = persistChatTurnAtomic({
                sessionId: session.id,
                userContent: inputText,
                assistantContent: doneFrame.outputText,
                provider: preferred,
                model: resolvedModel,
                stream: { events: streamEvents, status: 'done' },
                metadata: {
                  usage: null,
                  costEstimate: null,
                  completedAt: new Date().toISOString(),
                  correlation: { turn_id: turnCorrelationId, session_id: session.id },
                  context: contextPayload.meta,
                  tool: {
                    tool_outcome: 'needs_confirmation',
                    explicit_confirm: explicitConfirm,
                    action_mode: actionMode,
                  },
                  metrics: {
                    turn_latency_ms: Date.now() - turnStartedAt,
                    tool_attempts: 0,
                    tool_successes: 0,
                    tool_failures: 0,
                  },
                },
              });
              emitStructuredLog('chat.turn.completed', {
                correlation_id: turnCorrelationId,
                session_id: session.id,
                message_id: persistedIds.assistantMessageId,
                turn_latency_ms: Date.now() - turnStartedAt,
                stream_status: 'done',
                tool_attempts: 0,
                tool_successes: 0,
                tool_failures: 0,
              });
              persisted = true;
              res.end();
              return true;
            }
            toolCallsAttempted = 1;
            const startFrame = {
              type: 'tool_call_started',
              tool_call_id: supportedCall.id,
              tool_name: supportedCall.name,
              arguments: supportedCall.arguments,
            };
            streamEvents.push(startFrame);
            writeNdjson(res, startFrame);
            const adapter = buildChatToolAdapter(session.id);
            const outcome = await runChatToolOrchestration(adapter, {
              sessionId: session.id,
              toolCall: supportedCall as AgentToolCall,
              explicitConfirm,
            });
            if (outcome.status === 'executed') {
              toolCallsSucceeded = 1;
            }
            toolNarrationBefore = outcome.narration_before;
            toolNarrationAfter = outcome.narration_after;
            toolMetadata = {
              tool_outcome: outcome.status,
              missing_fields: outcome.missing_fields ?? null,
              disambiguation_prompt: outcome.disambiguation_prompt ?? null,
              result: outcome.result ?? null,
              explicit_confirm: explicitConfirm,
            };
            const resultFrame = {
              type: 'tool_call_result',
              tool_call_id: supportedCall.id,
              tool_name: supportedCall.name,
              outcome: outcome.status,
              narration_before: outcome.narration_before,
              narration_after: outcome.narration_after,
              missing_fields: outcome.missing_fields,
              disambiguation_prompt: outcome.disambiguation_prompt,
              result: outcome.result,
            };
            streamEvents.push(resultFrame);
            writeNdjson(res, resultFrame);
            if (outcome.status === 'needs_confirmation' || outcome.status === 'needs_disambiguation' || outcome.status === 'rejected') {
              const toolOnlyText = [
                outcome.narration_before,
                outcome.disambiguation_prompt,
                outcome.narration_after,
              ].filter(Boolean).join('\n\n');
              const doneFrame = { type: 'done', outputText: toolOnlyText, latencyMs: Date.now() - turnStartedAt };
              streamEvents.push(doneFrame);
              writeNdjson(res, doneFrame);
              const persistedIds = persistChatTurnAtomic({
                sessionId: session.id,
                userContent: inputText,
                assistantContent: toolOnlyText,
                provider: preferred,
                model: resolvedModel,
                stream: { events: streamEvents, status: 'done' },
                metadata: {
                  usage: null,
                  costEstimate: null,
                  completedAt: new Date().toISOString(),
                  correlation: { turn_id: turnCorrelationId, session_id: session.id },
                  context: contextPayload.meta,
                  tool: toolMetadata,
                  metrics: {
                    turn_latency_ms: Date.now() - turnStartedAt,
                    tool_attempts: toolCallsAttempted,
                    tool_successes: toolCallsSucceeded,
                    tool_failures: Math.max(0, toolCallsAttempted - toolCallsSucceeded),
                  },
                },
              });
              emitStructuredLog('chat.turn.completed', {
                correlation_id: turnCorrelationId,
                session_id: session.id,
                message_id: persistedIds.assistantMessageId,
                turn_latency_ms: Date.now() - turnStartedAt,
                stream_status: 'done',
                tool_attempts: toolCallsAttempted,
                tool_successes: toolCallsSucceeded,
                tool_failures: Math.max(0, toolCallsAttempted - toolCallsSucceeded),
              });
              persisted = true;
              res.end();
              return true;
            }
            generationPrompt = [
              contextPayload.prompt,
              '',
              '[TOOL_ORCHESTRATION]',
              toolNarrationBefore,
              toolNarrationAfter,
              `Tool result JSON: ${JSON.stringify(outcome.result ?? {})}`,
            ].filter(Boolean).join('\n');
            }
          } catch (planningError) {
            const planningErrorMessage = planningError instanceof Error ? planningError.message : 'Tool planning failed.';
            const errorFrame = { type: 'tool_planning_failed', message: planningErrorMessage };
            streamEvents.push(errorFrame);
            writeNdjson(res, errorFrame);
          }
          }
        }
        const generationStartedFrame = {
          type: 'response_generation_started',
          trace_id: 'response-generation',
          trace_name: 'response_generation',
          message: 'Generating final response.',
        };
        streamEvents.push(generationStartedFrame);
        writeNdjson(res, generationStartedFrame);
        const result = await providerRegistry[preferred].generate({
          model: resolvedModel,
          inputText: generationPrompt,
          generationParams: {
            ...(payload.generation_params as { temperature?: number; maxTokens?: number } | undefined),
            ...(preferred === 'ollama' ? { baseUrl: ollamaRuntime.baseUrl } : {}),
          },
        }, apiKey ?? '', controller.signal, {
          onTextDelta: (deltaText) => {
            if (!deltaText) return;
            assistantText += deltaText;
            const frame = { type: 'delta', deltaText };
            streamEvents.push(frame);
            writeNdjson(res, frame);
          },
        });
        const generationCompletedFrame = {
          type: 'response_generation_completed',
          trace_id: 'response-generation',
          trace_name: 'response_generation',
          message: 'Final response generated.',
        };
        streamEvents.push(generationCompletedFrame);
        writeNdjson(res, generationCompletedFrame);
        const doneFrame = { type: 'done', ...result };
        streamEvents.push(doneFrame);
        writeNdjson(res, doneFrame);
        const persistedIds = persistChatTurnAtomic({
          sessionId: session.id,
          userContent: inputText,
          assistantContent: result.outputText,
          provider: preferred,
          model: resolvedModel,
          stream: { events: streamEvents, status: 'done' },
          metadata: {
            usage: result.usage ?? null,
            costEstimate: result.costEstimate ?? null,
            completedAt: new Date().toISOString(),
            correlation: { turn_id: turnCorrelationId, session_id: session.id },
            context: contextPayload.meta,
            tool: toolMetadata,
            metrics: {
              turn_latency_ms: Date.now() - turnStartedAt,
              tool_attempts: toolCallsAttempted,
              tool_successes: toolCallsSucceeded,
              tool_failures: Math.max(0, toolCallsAttempted - toolCallsSucceeded),
            },
          },
        });
        const allMessages = queryJson<ChatMessageRow>(`select * from chat_messages where session_id = ${sqlEscape(session.id)} order by created_at asc, id asc`);
        const shouldSummarize = allMessages.length > policy.summarize_after_messages;
        if (shouldSummarize) {
          const olderMessages = allMessages.slice(0, Math.max(0, allMessages.length - policy.max_context_messages));
          const rollingSummary = buildRollingSummaryFromMessages(olderMessages);
          saveMemorySnapshot({
            sessionId: session.id,
            rollingSummary,
            pinnedMemory: snapshot?.pinnedMemory ?? null,
            lastMessageId: persistedIds.assistantMessageId,
          });
        }
        emitStructuredLog('chat.turn.completed', {
          correlation_id: turnCorrelationId,
          session_id: session.id,
          message_id: persistedIds.assistantMessageId,
          turn_latency_ms: Date.now() - turnStartedAt,
          stream_status: 'done',
          tool_attempts: toolCallsAttempted,
          tool_successes: toolCallsSucceeded,
          tool_failures: Math.max(0, toolCallsAttempted - toolCallsSucceeded),
        });
        persisted = true;
        res.end();
      } catch (error) {
        const cancelled = clientAborted;
        const message = cancelled ? 'Generation cancelled.' : (error instanceof Error ? error.message : 'Generation failed.');
        const generationFailedFrame = {
          type: 'response_generation_failed',
          trace_id: 'response-generation',
          trace_name: 'response_generation',
          message,
        };
        streamEvents.push(generationFailedFrame);
        const errorFrame = { type: 'error', message, aborted: cancelled };
        streamEvents.push(errorFrame);
        emitStructuredLog('chat.turn.stream_error', {
          correlation_id: turnCorrelationId,
          session_id: session.id,
          turn_latency_ms: Date.now() - turnStartedAt,
          cancelled,
          message,
        });
        if (res.headersSent) {
          writeNdjson(res, generationFailedFrame);
          writeNdjson(res, errorFrame);
          res.end();
        } else {
          writeJson(res, cancelled ? 499 : 400, { error: { message } });
        }
        if (!persisted) {
          const persistedIds = persistChatTurnAtomic({
            sessionId: session.id,
            userContent: inputText,
            assistantContent: assistantText,
            provider: preferred,
            model: resolvedModel,
            stream: { events: streamEvents, status: cancelled ? 'cancelled' : 'error' },
            metadata: {
              aborted: cancelled,
              error: message,
              completedAt: new Date().toISOString(),
              correlation: { turn_id: turnCorrelationId, session_id: session.id },
              context: contextPayload.meta,
              metrics: {
                turn_latency_ms: Date.now() - turnStartedAt,
                tool_attempts: 0,
                tool_successes: 0,
                tool_failures: 0,
              },
            },
          });
          emitStructuredLog('chat.turn.persisted_with_error', {
            correlation_id: turnCorrelationId,
            session_id: session.id,
            message_id: persistedIds.assistantMessageId,
            turn_latency_ms: Date.now() - turnStartedAt,
            stream_status: cancelled ? 'cancelled' : 'error',
          });
          persisted = true;
        }
      }
      return true;
    }

    if (req.method === 'DELETE' && url.startsWith('/api/chat/session/current/history')) {
      const parsedUrl = new URL(url, 'http://localhost');
      const range = parsedUrl.searchParams.get('range');
      if (range !== '24h' && range !== '7d' && range !== 'all') {
        writeJson(res, 400, { error: { message: 'range must be 24h, 7d, or all.' } });
        return true;
      }
      const session = getOrCreatePrimaryChatSession(DEFAULT_CHAT_USER_ID);
      const purgeResult = purgeChatHistoryByRange(session.id, range);
      if (range === 'all') {
        execSql(`delete from chat_memory_snapshots where session_id = ${sqlEscape(session.id)}`);
      }
      writeJson(res, 200, { session_id: session.id, range, ...purgeResult });
      return true;
    }

    if (req.method === 'POST' && url === '/api/chat/session/current/reset-context') {
      const session = getOrCreatePrimaryChatSession(DEFAULT_CHAT_USER_ID);
      execSql(`delete from chat_memory_snapshots where session_id = ${sqlEscape(session.id)};`);
      const marker = appendChatMessage({
        sessionId: session.id,
        role: 'system',
        content: 'Context summary reset by user.',
        metadata: { source: 'reset-context' },
      });
      writeJson(res, 200, { error: null, session_id: session.id, marker });
      return true;
    }

    if (req.method === 'GET' && url === '/api/chat/settings') {
      const row = getOrCreateChatSettings(DEFAULT_CHAT_USER_ID);
      const policyRecord = parseJsonOrNull<Record<string, unknown>>(row.policy_json);
      const normalizedPolicy = normalizeChatSettingsPolicy(policyRecord);
      if (normalizedPolicy.warningCode) {
        emitStructuredLog('chat.action_mode.warning', {
          code: normalizedPolicy.warningCode,
          raw_value: normalizedPolicy.normalizedFrom,
          fallback_mode: normalizedPolicy.actionMode,
          path: '/api/chat/settings',
        });
      }
      const policyJson = JSON.stringify(normalizedPolicy.policy);
      if (policyJson !== row.policy_json) {
        execSql(`
          update chat_settings set
            policy_json = ${sqlEscape(policyJson)},
            updated_at = ${sqlEscape(new Date().toISOString())}
          where id = ${sqlEscape(row.id)}
        `);
      }
      writeJson(res, 200, {
        id: row.id,
        user_id: row.user_id,
        policy: normalizedPolicy.policy,
        profile: parseJsonOrNull<Record<string, unknown>>(row.profile_json),
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
      return true;
    }

    if (req.method === 'PUT' && url === '/api/chat/settings') {
      const payload = await readJsonBody(req);
      const existing = getOrCreateChatSettings(DEFAULT_CHAT_USER_ID);
      const rawPolicy = payload.policy && typeof payload.policy === 'object'
        ? payload.policy as Record<string, unknown>
        : parseJsonOrNull<Record<string, unknown>>(existing.policy_json) ?? DEFAULT_CHAT_SETTINGS_POLICY;
      const normalizedPolicy = normalizeChatSettingsPolicy(rawPolicy);
      if (normalizedPolicy.warningCode) {
        emitStructuredLog('chat.action_mode.warning', {
          code: normalizedPolicy.warningCode,
          raw_value: normalizedPolicy.normalizedFrom,
          fallback_mode: normalizedPolicy.actionMode,
          path: '/api/chat/settings',
        });
      }
      const profile = payload.profile && typeof payload.profile === 'object'
        ? payload.profile as Record<string, unknown>
        : parseJsonOrNull<Record<string, unknown>>(existing.profile_json);
      const now = new Date().toISOString();
      execSql(`
        update chat_settings set
          policy_json = ${sqlEscape(JSON.stringify(normalizedPolicy.policy))},
          profile_json = ${sqlEscape(profile ? JSON.stringify(profile) : null)},
          updated_at = ${sqlEscape(now)}
        where id = ${sqlEscape(existing.id)}
      `);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'POST' && url === '/api/chat/profile/reload') {
      const existing = getOrCreateChatSettings(DEFAULT_CHAT_USER_ID);
      const currentProfile = parseJsonOrNull<Record<string, unknown>>(existing.profile_json) ?? {};
      const reloadedProfile = {
        ...currentProfile,
        reloaded_at: new Date().toISOString(),
      };
      execSql(`
        update chat_settings set
          profile_json = ${sqlEscape(JSON.stringify(reloadedProfile))},
          updated_at = ${sqlEscape(new Date().toISOString())}
        where id = ${sqlEscape(existing.id)}
      `);
      writeJson(res, 200, { error: null, profile: reloadedProfile });
      return true;
    }

    if (req.method === 'GET' && url.startsWith('/api/chat/session/current/export')) {
      const parsedUrl = new URL(url, 'http://localhost');
      const format = parsedUrl.searchParams.get('format');
      if (format !== 'json' && format !== 'markdown') {
        writeJson(res, 400, { error: { message: 'format must be json or markdown.' } });
        return true;
      }
      const session = getOrCreatePrimaryChatSession(DEFAULT_CHAT_USER_ID);
      const transcript = assembleTranscriptExportPayload(session.id);
      if (!transcript) {
        writeJson(res, 404, { error: { message: 'Session not found.' } });
        return true;
      }
      if (format === 'markdown') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.end(transcript.markdown);
        return true;
      }
      writeJson(res, 200, transcript.json);
      return true;
    }

    if (req.method === 'GET' && url === '/api/agent/settings') {
      writeJson(res, 200, getAgentSettings());
      return true;
    }

    if (req.method === 'PUT' && url === '/api/agent/settings') {
      const payload = await readJsonBody(req);
      const provider = payload.default_provider;
      if (!isAgentProvider(provider)) {
        writeJson(res, 400, { error: { message: 'Invalid provider.' } });
        return true;
      }
      let defaultModel = String(payload.default_model ?? '').trim();
      const generationParams = normalizeAgentGenerationParams(payload.generation_params);
      if (provider === 'ollama' && defaultModel && generationParams?.local_connection) {
        generationParams.local_connection.model = defaultModel;
      }
      if (provider === 'ollama' && !defaultModel && generationParams?.local_connection?.model) {
        defaultModel = generationParams.local_connection.model;
      }
      const ollamaRuntime = resolveOllamaRuntimeConfig({
        default_provider: provider,
        default_model: defaultModel,
        generation_params: generationParams,
      });
      if (generationParams?.local_connection) {
        generationParams.local_connection.base_url = ollamaRuntime.baseUrl;
        generationParams.local_connection.model = ollamaRuntime.model;
      }
      if (provider === 'ollama') {
        defaultModel = ollamaRuntime.model;
      }
      if (generationParams?.web_search?.enabled && !supportsToolCalling(provider, defaultModel)) {
        const providerDisplay = providerLabel(provider);
        const modelDisplay = defaultModel || 'not selected';
        writeJson(res, 400, {
          error: {
            message: `Web search requires tool calling support when validating the saved default provider/model (${providerDisplay} / ${modelDisplay}). Save a tool-capable default model first, or disable web search.`,
          },
        });
        return true;
      }
      execSql(`update agent_settings set
        default_provider = ${sqlEscape(provider)},
        default_model = ${sqlEscape(defaultModel)},
        generation_params_json = ${sqlEscape(generationParams ? JSON.stringify(generationParams) : null)}
        where id = 1`);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'GET' && /^\/api\/agent\/credentials\/[^/]+$/.test(url)) {
      const provider = url.replace('/api/agent/credentials/', '').trim();
      if (!isAgentProvider(provider)) {
        writeJson(res, 400, { error: { message: 'Invalid provider.' } });
        return true;
      }
      const apiKey = secretStore.get(provider);
      writeJson(res, 200, { has_key: Boolean(apiKey) });
      return true;
    }

    if (req.method === 'PUT' && /^\/api\/agent\/credentials\/[^/]+$/.test(url)) {
      const provider = url.replace('/api/agent/credentials/', '').trim();
      if (!isAgentProvider(provider)) {
        writeJson(res, 400, { error: { message: 'Invalid provider.' } });
        return true;
      }
      const payload = await readJsonBody(req);
      const apiKey = String(payload.api_key ?? '').trim();
      if (!apiKey) {
        writeJson(res, 400, { error: { message: 'API key is required.' } });
        return true;
      }
      secretStore.set(provider, apiKey);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'DELETE' && /^\/api\/agent\/credentials\/[^/]+$/.test(url)) {
      const provider = url.replace('/api/agent/credentials/', '').trim();
      if (!isAgentProvider(provider)) {
        writeJson(res, 400, { error: { message: 'Invalid provider.' } });
        return true;
      }
      secretStore.delete(provider);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'GET' && url.startsWith('/api/agent/models')) {
      const parsedUrl = new URL(url, 'http://localhost');
      const provider = parsedUrl.searchParams.get('provider');
      if (!isAgentProvider(provider)) {
        writeJson(res, 400, { error: { message: 'Invalid provider.' } });
        return true;
      }
      const settings = getAgentSettings();
      const preferredModel = settings.default_provider === provider ? settings.default_model : undefined;
      const fallbackModels = FALLBACK_MODELS[provider];
      const ollamaRuntime = resolveOllamaRuntimeConfig(settings);
      const runtimeBaseUrlOverride = normalizeEndpointUrl(parsedUrl.searchParams.get('runtime_base_url'), ollamaRuntime.baseUrl);
      const apiKey = secretStore.get(provider);
      if (provider !== 'ollama' && !apiKey) {
        writeJson(res, 200, {
          models: fallbackModels,
          selected_model: selectBestModel(provider, [], fallbackModels, preferredModel).selected_model,
          catalog_status: 'failed',
          selection_source: 'provider_fallback',
          reason_code: 'missing_api_key',
        });
        return true;
      }

      const result = await providerRegistry[provider].listModels(apiKey ?? '', {
        fallbackModels,
        preferredModel,
        baseUrl: provider === 'ollama' ? runtimeBaseUrlOverride : ollamaRuntime.baseUrl,
      });
      if (result.catalog_status !== 'live') {
        console.warn('[agent-models] catalog fallback', { provider, catalog_status: result.catalog_status, reason_code: result.reason_code });
      }
      writeJson(res, 200, result);
      return true;
    }

    if (req.method === 'GET' && url.startsWith('/api/agent/activity-log')) {
      const parsedUrl = new URL(url, 'http://localhost');
      const limit = Math.min(50, Math.max(1, Number.parseInt(parsedUrl.searchParams.get('limit') ?? '10', 10) || 10));
      const rows = agentActivityBuffer.slice(-limit).reverse();
      writeJson(res, 200, rows);
      return true;
    }

    if (req.method === 'GET' && url === '/api/agent/preferred-sources') {
      const rows = queryJson<PreferredSourceRow>('select * from preferred_sources order by weight desc, domain asc');
      writeJson(res, 200, rows.map(normalizePreferredSourceRow));
      return true;
    }

    if (req.method === 'POST' && url === '/api/agent/preferred-sources') {
      const payload = await readJsonBody(req);
      const domain = normalizeDomain(payload.domain);
      if (!domain || !isValidDomain(domain)) {
        writeJson(res, 400, { error: { message: 'Invalid domain format.' } });
        return true;
      }
      const weight = parseOptionalWeight(payload.weight);
      if (Number.isNaN(weight)) {
        writeJson(res, 400, { error: { message: 'Weight must be between 1 and 100.' } });
        return true;
      }
      const enabled = typeof payload.enabled === 'boolean' ? payload.enabled : true;
      const existing = queryJson<Pick<PreferredSourceRow, 'id'>>(
        `select id from preferred_sources where domain = ${sqlEscape(domain)} limit 1`,
      )[0];
      if (existing) {
        writeJson(res, 409, { error: { message: 'Domain already exists.' } });
        return true;
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      execSql(`insert into preferred_sources (id, domain, weight, enabled, created_at, updated_at) values (${sqlEscape(id)}, ${sqlEscape(domain)}, ${sqlEscape(weight ?? 1)}, ${sqlEscape(enabled ? 1 : 0)}, ${sqlEscape(now)}, ${sqlEscape(now)})`);
      const created = queryJson<PreferredSourceRow>(`select * from preferred_sources where id = ${sqlEscape(id)} limit 1`)[0];
      writeJson(res, 200, normalizePreferredSourceRow(created));
      return true;
    }

    if (req.method === 'PATCH' && /^\/api\/agent\/preferred-sources\/[^/]+$/.test(url)) {
      const id = url.replace('/api/agent/preferred-sources/', '').trim();
      const existing = queryJson<PreferredSourceRow>(`select * from preferred_sources where id = ${sqlEscape(id)} limit 1`)[0];
      if (!existing) {
        writeJson(res, 404, { error: { message: 'Preferred source not found.' } });
        return true;
      }
      const payload = await readJsonBody(req);
      const nextDomain = payload.domain === undefined ? existing.domain : normalizeDomain(payload.domain);
      if (!nextDomain || !isValidDomain(nextDomain)) {
        writeJson(res, 400, { error: { message: 'Invalid domain format.' } });
        return true;
      }
      const weight = parseOptionalWeight(payload.weight);
      if (Number.isNaN(weight)) {
        writeJson(res, 400, { error: { message: 'Weight must be between 1 and 100.' } });
        return true;
      }
      const nextWeight = weight ?? existing.weight;
      const nextEnabled = typeof payload.enabled === 'boolean' ? payload.enabled : Boolean(existing.enabled);
      const duplicate = queryJson<Pick<PreferredSourceRow, 'id'>>(
        `select id from preferred_sources where domain = ${sqlEscape(nextDomain)} and id != ${sqlEscape(id)} limit 1`,
      )[0];
      if (duplicate) {
        writeJson(res, 409, { error: { message: 'Domain already exists.' } });
        return true;
      }
      const now = new Date().toISOString();
      execSql(`update preferred_sources set
        domain = ${sqlEscape(nextDomain)},
        weight = ${sqlEscape(nextWeight)},
        enabled = ${sqlEscape(nextEnabled ? 1 : 0)},
        updated_at = ${sqlEscape(now)}
        where id = ${sqlEscape(id)}`);
      const updated = queryJson<PreferredSourceRow>(`select * from preferred_sources where id = ${sqlEscape(id)} limit 1`)[0];
      writeJson(res, 200, normalizePreferredSourceRow(updated));
      return true;
    }

    if (req.method === 'DELETE' && /^\/api\/agent\/preferred-sources\/[^/]+$/.test(url)) {
      const id = url.replace('/api/agent/preferred-sources/', '').trim();
      const existing = queryJson<Pick<PreferredSourceRow, 'id'>>(`select id from preferred_sources where id = ${sqlEscape(id)} limit 1`)[0];
      if (!existing) {
        writeJson(res, 404, { error: { message: 'Preferred source not found.' } });
        return true;
      }
      execSql(`delete from preferred_sources where id = ${sqlEscape(id)}`);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'DELETE' && url === '/api/agent/activity-log') {
      agentActivityBuffer.length = 0;
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'GET' && url === '/api/attachments/settings') {
      writeJson(res, 200, { ...getAttachmentSettings(), ...getAttachmentUsage() });
      return true;
    }

    if (req.method === 'PUT' && url === '/api/attachments/settings') {
      const payload = await readJsonBody(req);
      const nextQuota = Math.max(50, Math.floor(Number(payload.quota_mb ?? DEFAULT_ATTACHMENT_QUOTA_MB)));
      const nextRetention = Math.max(1, Math.floor(Number(payload.retention_days ?? DEFAULT_ATTACHMENT_RETENTION_DAYS)));
      execSql(`update attachment_settings set quota_mb = ${sqlEscape(nextQuota)}, retention_days = ${sqlEscape(nextRetention)} where id = 1`);
      writeJson(res, 200, { quota_mb: nextQuota, retention_days: nextRetention, ...getAttachmentUsage() });
      return true;
    }

    if (req.method === 'POST' && url === '/api/attachments/cleanup') {
      writeJson(res, 200, runAttachmentCleanup());
      return true;
    }

    if (req.method === 'POST' && url === '/api/attachments/upload') {
      const multipart = await readMultipartUploadBody(req);
      const workspaceId = String(multipart.fields.workspace_id ?? '').trim();
      const linkType = coerceLinkType(multipart.fields.link_type);
      const linkId = String(multipart.fields.link_id ?? '').trim();
      const originalName = String(multipart.fields.original_name ?? multipart.file?.filename ?? '').trim();
      const mimeType = String(multipart.fields.mime_type ?? multipart.file?.mimeType ?? 'application/octet-stream').trim() || 'application/octet-stream';
      const rawBuffer = multipart.file?.buffer ?? Buffer.alloc(0);
      if (!workspaceId || !linkType || !linkId || !originalName || rawBuffer.byteLength === 0) {
        writeJson(res, 400, { error: { message: 'workspace_id, link_type, link_id, original_name, and file are required.' } });
        return true;
      }
      if (!ensureLinkTargetExists(linkType, linkId)) {
        writeJson(res, 404, { error: { message: 'Link target not found.' } });
        return true;
      }
      const existingLinkCount = queryJson<{ total: number }>(`select count(*) as total from attachment_links where link_type = ${sqlEscape(linkType)} and link_id = ${sqlEscape(linkId)}`)[0];
      if (Number(existingLinkCount?.total ?? 0) >= MAX_LINKS_PER_ENTITY) {
        writeJson(res, 409, { error: { message: `Max ${MAX_LINKS_PER_ENTITY} attachments allowed per ${linkType}.` } });
        return true;
      }
      if (rawBuffer.byteLength > MAX_ATTACHMENT_SIZE_BYTES) {
        writeJson(res, 413, { error: { message: 'Attachment exceeds 10MB upload limit.' } });
        return true;
      }
      const { quota_mb } = getAttachmentSettings();
      const usage = getAttachmentUsage();
      if (usage.usage_bytes + rawBuffer.byteLength > quota_mb * 1024 * 1024) {
        writeJson(res, 413, { error: { message: `Attachment quota exceeded (${quota_mb}MB).` } });
        return true;
      }
      const extension = path.extname(originalName).replace('.', '').toLowerCase();
      const attachmentId = randomUUID();
      const now = new Date().toISOString();
      const tempPath = path.join(attachmentsTmpPath, `${attachmentId}.upload`);
      writeFileSync(tempPath, rawBuffer);
      const sha256 = createHash('sha256').update(rawBuffer).digest('hex');
      const parseResult = parseAttachmentText(extension, originalName, rawBuffer);
      const finalDir = path.join(attachmentsRootPath, workspaceId);
      mkdirSync(finalDir, { recursive: true });
      const finalFileName = extension ? `${attachmentId}.${extension}` : attachmentId;
      const finalPath = path.join(finalDir, finalFileName);
      renameSync(tempPath, finalPath);
      const storageRelpath = path.relative(attachmentsRootPath, finalPath).split(path.sep).join('/');
      const estimatedTokens = estimateTokens(parseResult.parsedText ?? '');
      execSql(`
        begin;
        insert into attachments (id, workspace_id, storage_relpath, original_name, mime_type, extension, size_bytes, sha256, estimated_tokens, parse_status, parsed_text, created_at, updated_at, deleted_at)
        values (${sqlEscape(attachmentId)}, ${sqlEscape(workspaceId)}, ${sqlEscape(storageRelpath)}, ${sqlEscape(originalName)}, ${sqlEscape(mimeType)}, ${sqlEscape(extension)}, ${sqlEscape(rawBuffer.byteLength)}, ${sqlEscape(sha256)}, ${sqlEscape(estimatedTokens)}, ${sqlEscape(parseResult.parseStatus)}, ${sqlEscape(parseResult.parsedText)}, ${sqlEscape(now)}, ${sqlEscape(now)}, null);
        insert into attachment_links (id, attachment_id, link_type, link_id, created_at) values (${sqlEscape(randomUUID())}, ${sqlEscape(attachmentId)}, ${sqlEscape(linkType)}, ${sqlEscape(linkId)}, ${sqlEscape(now)});
        commit;
      `);
      const created = queryJson<AttachmentRow>(`select * from attachments where id = ${sqlEscape(attachmentId)} limit 1`)[0];
      writeJson(res, 200, created);
      return true;
    }

    if (req.method === 'GET' && url.startsWith('/api/attachments?')) {
      const parsedUrl = new URL(url, 'http://localhost');
      const linkType = coerceLinkType(parsedUrl.searchParams.get('linkType'));
      const linkId = parsedUrl.searchParams.get('linkId')?.trim() ?? '';
      if (!linkType || !linkId) {
        writeJson(res, 400, { error: { message: 'linkType and linkId are required.' } });
        return true;
      }
      const attachments = queryJson<AttachmentRow>(`
        select a.* from attachments a
        inner join attachment_links l on l.attachment_id = a.id
        where l.link_type = ${sqlEscape(linkType)} and l.link_id = ${sqlEscape(linkId)} and a.deleted_at is null
        order by a.created_at desc
      `);
      writeJson(res, 200, attachments);
      return true;
    }

    if (req.method === 'GET' && url.startsWith('/api/attachments/counts?')) {
      const parsedUrl = new URL(url, 'http://localhost');
      const linkType = coerceLinkType(parsedUrl.searchParams.get('linkType'));
      const rawIds = parsedUrl.searchParams.get('ids') ?? '';
      const ids = Array.from(new Set(rawIds.split(',').map((value) => value.trim()).filter(Boolean))).slice(0, 200);
      if (!linkType || ids.length === 0) {
        writeJson(res, 400, { error: { message: 'linkType and ids are required.' } });
        return true;
      }
      const idsSql = ids.map((value) => sqlEscape(value)).join(', ');
      const counts = queryJson<Array<{ link_id: string; count: number }>[number]>(`
        select l.link_id as link_id, count(*) as count
        from attachment_links l
        inner join attachments a on a.id = l.attachment_id
        where l.link_type = ${sqlEscape(linkType)}
          and l.link_id in (${idsSql})
          and a.deleted_at is null
        group by l.link_id
      `);
      writeJson(res, 200, counts);
      return true;
    }

    if (req.method === 'POST' && /^\/api\/attachments\/[^/]+\/link$/.test(url)) {
      const attachmentId = url.replace('/api/attachments/', '').replace('/link', '').trim();
      const payload = await readJsonBody(req);
      const linkType = coerceLinkType(payload.link_type);
      const linkId = String(payload.link_id ?? '').trim();
      if (!attachmentId || !linkType || !linkId) {
        writeJson(res, 400, { error: { message: 'attachment id, link_type and link_id are required.' } });
        return true;
      }
      if (!ensureLinkTargetExists(linkType, linkId)) {
        writeJson(res, 404, { error: { message: 'Link target not found.' } });
        return true;
      }
      const existingLinkCount = queryJson<{ total: number }>(`select count(*) as total from attachment_links where link_type = ${sqlEscape(linkType)} and link_id = ${sqlEscape(linkId)}`)[0];
      if (Number(existingLinkCount?.total ?? 0) >= MAX_LINKS_PER_ENTITY) {
        writeJson(res, 409, { error: { message: `Max ${MAX_LINKS_PER_ENTITY} attachments allowed per ${linkType}.` } });
        return true;
      }
      const exists = queryJson<Pick<AttachmentRow, 'id'>>(`select id from attachments where id = ${sqlEscape(attachmentId)} limit 1`)[0];
      if (!exists) {
        writeJson(res, 404, { error: { message: 'Attachment not found.' } });
        return true;
      }
      const now = new Date().toISOString();
      execSql(`
        begin;
        insert or ignore into attachment_links (id, attachment_id, link_type, link_id, created_at)
        values (${sqlEscape(randomUUID())}, ${sqlEscape(attachmentId)}, ${sqlEscape(linkType)}, ${sqlEscape(linkId)}, ${sqlEscape(now)});
        update attachments set deleted_at = null, updated_at = ${sqlEscape(now)} where id = ${sqlEscape(attachmentId)};
        commit;
      `);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'DELETE' && /^\/api\/attachments\/[^/]+$/.test(url)) {
      const attachmentId = url.replace('/api/attachments/', '').trim();
      const payload = await readJsonBody(req);
      const linkType = coerceLinkType(payload.link_type);
      const linkId = String(payload.link_id ?? '').trim();
      if (!attachmentId || !linkType || !linkId) {
        writeJson(res, 400, { error: { message: 'attachment id, link_type and link_id are required.' } });
        return true;
      }
      execSql(`delete from attachment_links where attachment_id = ${sqlEscape(attachmentId)} and link_type = ${sqlEscape(linkType)} and link_id = ${sqlEscape(linkId)}`);
      const remaining = queryJson<{ total: number }>(`select count(*) as total from attachment_links where attachment_id = ${sqlEscape(attachmentId)}`)[0];
      if (Number(remaining?.total ?? 0) === 0) {
        execSql(`update attachments set deleted_at = ${sqlEscape(new Date().toISOString())}, updated_at = ${sqlEscape(new Date().toISOString())} where id = ${sqlEscape(attachmentId)}`);
      }
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'POST' && url === '/api/agent/generate') {
      const payload = await readJsonBody(req);
      const actionCorrelationId = randomUUID();
      const provider = payload.provider;
      if (!isAgentProvider(provider)) {
        writeJson(res, 400, { error: { message: 'Invalid provider.' } });
        return true;
      }
      const model = String(payload.model ?? '').trim();
      const inputText = String(payload.input_text ?? '');
      const contextTaskId = String(payload.task_id ?? '').trim();
      const contextNoteId = String(payload.note_id ?? '').trim();
      const explicitAttachmentIds = Array.isArray(payload.attachment_ids)
        ? payload.attachment_ids.map((value) => String(value ?? '').trim()).filter(Boolean)
        : [];
      if (provider !== 'ollama' && !model) {
        writeJson(res, 400, { error: { message: 'Model is required.' } });
        return true;
      }
      if (!inputText.trim()) {
        writeJson(res, 400, { error: { message: 'Input text is required.' } });
        return true;
      }
      const settings = getAgentSettings();
      const ollamaRuntime = resolveOllamaRuntimeConfig(settings);
      const resolvedModel = provider === 'ollama' ? ollamaRuntime.model : model;
      if (!resolvedModel) {
        writeJson(res, 400, { error: { message: 'Model is required.' } });
        return true;
      }
      const now = new Date().toISOString();
      const startedAt = Date.now();
      emitStructuredLog('agent.generate.started', {
        correlation_id: actionCorrelationId,
        action: 'generate',
        provider,
        model: resolvedModel,
      });
      appendAgentActivityLog({
        timestamp: now,
        note_id: String(payload.note_id ?? ''),
        action: 'generate',
        trigger_source: String(payload.trigger_source ?? 'manual'),
        initiated_by: String(payload.initiated_by ?? 'user'),
        provider,
        model: resolvedModel,
        status: 'started',
        duration_ms: null,
        input_chars: inputText.length,
        output_chars: 0,
        token_estimate: null,
        cost_estimate_usd: null,
        error_message_short: null,
        search_warning: 0,
        search_warning_message: null,
        web_search_enabled: settings.generation_params?.web_search?.enabled ? 1 : 0,
        tool_calls_attempted: 0,
        tool_calls_succeeded: 0,
        search_query_count: 0,
        source_count: 0,
        tool_failure_reason: null,
        citation_events_json: null,
      });
      const apiKey = secretStore.get(provider);
      if (provider !== 'ollama' && !apiKey) {
        appendAgentActivityLog({
          timestamp: new Date().toISOString(),
          note_id: String(payload.note_id ?? ''),
          action: 'generate',
          trigger_source: String(payload.trigger_source ?? 'manual'),
          initiated_by: String(payload.initiated_by ?? 'user'),
          provider,
          model: resolvedModel,
          status: 'failed',
          duration_ms: Date.now() - startedAt,
          input_chars: inputText.length,
          output_chars: 0,
          token_estimate: null,
          cost_estimate_usd: null,
          error_message_short: 'Missing API key.',
          search_warning: 0,
          search_warning_message: null,
          web_search_enabled: settings.generation_params?.web_search?.enabled ? 1 : 0,
          tool_calls_attempted: 0,
          tool_calls_succeeded: 0,
          search_query_count: 0,
          source_count: 0,
          tool_failure_reason: 'Missing API key.',
          citation_events_json: null,
        });
        writeJson(res, 400, { error: { message: 'Missing API key for selected provider.' } });
        return true;
      }
      const isWebSearchEnabled = Boolean(settings.generation_params?.web_search?.enabled);
      if (isWebSearchEnabled && !supportsToolCalling(provider, resolvedModel)) {
        const reason = `Web search requires tool calling support for ${provider}/${resolvedModel}.`;
        appendAgentActivityLog({
          timestamp: new Date().toISOString(),
          note_id: String(payload.note_id ?? ''),
          action: 'generate',
          trigger_source: String(payload.trigger_source ?? 'manual'),
          initiated_by: String(payload.initiated_by ?? 'user'),
          provider,
          model: resolvedModel,
          status: 'failed',
          duration_ms: Date.now() - startedAt,
          input_chars: inputText.length,
          output_chars: 0,
          token_estimate: null,
          cost_estimate_usd: null,
          error_message_short: reason,
          search_warning: 0,
          search_warning_message: null,
          web_search_enabled: 1,
          tool_calls_attempted: 0,
          tool_calls_succeeded: 0,
          search_query_count: 0,
          source_count: 0,
          tool_failure_reason: reason,
          citation_events_json: null,
        });
        writeJson(res, 400, { error: { message: reason } });
        return true;
      }
      const controller = new AbortController();
      let clientAborted = false;
      req.on('aborted', () => {
        clientAborted = true;
        controller.abort();
      });
      let toolCallsAttempted = 0;
      let toolCallsSucceeded = 0;
      let queryCount = 0;
      let sourceCount = 0;
      let toolFailureReason: string | null = null;
      beginNdjson(res);
      writeNdjson(res, { type: 'status', stage: 'started' });
      try {
        const preferredSources = queryJson<PreferredSourceRow>('select * from preferred_sources where enabled = 1 order by weight desc, domain asc');
        const normalizedWebSearchConfig = settings.generation_params?.web_search ?? {
          enabled: false,
          fail_open_on_tool_error: WEB_SEARCH_FAIL_OPEN_ON_TOOL_ERROR_DEFAULT,
          provider: WEB_SEARCH_PROVIDER_DEFAULT,
          mode: WEB_SEARCH_MODE_DEFAULT,
          max_results: WEB_SEARCH_MAX_RESULTS_DEFAULT,
          timeout_ms: WEB_SEARCH_TIMEOUT_MS_DEFAULT,
          safe_search: WEB_SEARCH_SAFE_SEARCH_DEFAULT,
          recency: WEB_SEARCH_RECENCY_DEFAULT,
          domain_policy: WEB_SEARCH_DOMAIN_POLICY_DEFAULT,
          source_citation: false,
          provider_config: {
            searxng: {
              base_url: WEB_SEARCH_SEARXNG_BASE_URL_DEFAULT,
              use_json_api: WEB_SEARCH_SEARXNG_USE_JSON_API_DEFAULT,
            },
          },
        };
        const webSearchMetadata: PreparedWebSearchContext = {
          enabled: Boolean(normalizedWebSearchConfig.enabled),
          provider: normalizedWebSearchConfig.provider,
          mode: normalizedWebSearchConfig.mode,
          queryCount,
          sourceCount,
        };
        let normalizedSources: ReturnType<typeof normalizeStreamingSources> = [];
        let preparedInputText = inputText;
        const attachmentCandidateIds = new Set<string>(explicitAttachmentIds);
        if (contextTaskId) {
          const task = queryJson<Pick<NewResearchTaskRow, 'linked_note_file_id'>>(`select linked_note_file_id from new_research_tasks where id = ${sqlEscape(contextTaskId)} limit 1`)[0];
          const taskAttachments = queryJson<Pick<AttachmentRow, 'id'>>(`select attachment_id as id from attachment_links where link_type = 'task' and link_id = ${sqlEscape(contextTaskId)}`);
          taskAttachments.forEach((row) => attachmentCandidateIds.add(row.id));
          if (task?.linked_note_file_id) {
            const linkedNoteAttachments = queryJson<Pick<AttachmentRow, 'id'>>(`select attachment_id as id from attachment_links where link_type = 'note' and link_id = ${sqlEscape(task.linked_note_file_id)}`);
            linkedNoteAttachments.forEach((row) => attachmentCandidateIds.add(row.id));
          }
        }
        if (contextNoteId) {
          const noteAttachments = queryJson<Pick<AttachmentRow, 'id'>>(`select attachment_id as id from attachment_links where link_type = 'note' and link_id = ${sqlEscape(contextNoteId)}`);
          noteAttachments.forEach((row) => attachmentCandidateIds.add(row.id));
        }
        if (attachmentCandidateIds.size > 0) {
          const idsSql = Array.from(attachmentCandidateIds).map((id) => sqlEscape(id)).join(', ');
          const candidates = queryJson<AttachmentRow>(`select * from attachments where id in (${idsSql}) and deleted_at is null and parse_status = 'parsed' and parsed_text is not null order by created_at asc`);
          let consumed = 0;
          const contextLines: string[] = ['[ATTACHMENT_CONTEXT_BEGIN]'];
          candidates.forEach((attachment, index) => {
            if (!attachment.parsed_text || consumed >= ATTACHMENT_CONTEXT_TOKEN_BUDGET) return;
            const chunkBudgetChars = Math.max(200, (ATTACHMENT_CONTEXT_TOKEN_BUDGET - consumed) * 4);
            const nextChunk = attachment.parsed_text.slice(0, chunkBudgetChars);
            const nextTokens = estimateTokens(nextChunk);
            consumed += nextTokens;
            contextLines.push(`### Source ${index + 1}: ${attachment.original_name} [attachment:${attachment.id}]`);
            contextLines.push(nextChunk);
          });
          contextLines.push('[ATTACHMENT_CONTEXT_END]');
          if (contextLines.length > 2) {
            preparedInputText = `${contextLines.join('\n\n')}\n\n${inputText}`;
          }
        }
        let searchWarningMessage: string | null = null;
        const routingDecision = decideWebSearchRouting(inputText);
        const citationRequested = shouldRenderCitationsForChatPrompt(inputText);
        const effectiveWebSearchConfig = {
          ...normalizedWebSearchConfig,
          source_citation: citationRequested,
        };
        if (normalizedWebSearchConfig.enabled && routingDecision.shouldSearch) {
          try {
            const orchestration = await runAgentToolOrchestration({
              provider,
              model: resolvedModel,
              inputText,
              apiKey: apiKey ?? '',
              baseUrl: provider === 'ollama' ? ollamaRuntime.baseUrl : undefined,
              settings: effectiveWebSearchConfig,
              preferredSources: preferredSources.map((source) => ({ domain: source.domain, weight: source.weight })),
              signal: controller.signal,
              onEvent: (event) => {
                if (event.type === 'tool_call_started') {
                  toolCallsAttempted += 1;
                  queryCount += 1;
                } else if (event.type === 'tool_call_result') {
                  toolCallsSucceeded += 1;
                  sourceCount += event.sourceCount;
                } else if (event.type === 'tool_call_failed') {
                  toolFailureReason = event.reason;
                }
                writeNdjson(res, { type: event.type, ...event });
              },
            });
            normalizedSources = normalizeStreamingSources(orchestration.allSources);
            toolCallsAttempted = orchestration.toolCallsAttempted;
            toolCallsSucceeded = orchestration.toolCallsSucceeded;
            queryCount = orchestration.queryCount;
            sourceCount = orchestration.sourceCount;
            toolFailureReason = orchestration.toolFailureReason;
            webSearchMetadata.queryCount = queryCount;
            webSearchMetadata.sourceCount = sourceCount;
            preparedInputText = orchestration.consumedInputText;
          } catch (error) {
            const reason = error instanceof Error ? error.message : 'Web search tool orchestration failed.';
            searchWarningMessage = reason;
            toolFailureReason = reason;
            writeNdjson(res, { type: 'search_warning', message: reason, fail_open: effectiveWebSearchConfig.fail_open_on_tool_error });
            if (effectiveWebSearchConfig.fail_open_on_tool_error) {
              preparedInputText = inputText;
            } else {
              throw error;
            }
          }
          emitStructuredLog('agent.tools.outcome', {
            correlation_id: actionCorrelationId,
            action: 'generate',
            tool_attempts: toolCallsAttempted,
            tool_successes: toolCallsSucceeded,
            tool_failures: Math.max(0, toolCallsAttempted - toolCallsSucceeded),
            tool_failure_reason: toolFailureReason,
            search_warning: searchWarningMessage,
          });
        } else if (normalizedWebSearchConfig.enabled) {
          writeNdjson(res, {
            type: 'search_skipped',
            reason: routingDecision.reason,
            web_search_enabled: true,
          });
        }
        if (normalizedSources.length > 0) {
          writeNdjson(res, { type: 'sources', sources: normalizedSources });
        }
        const generationParams = buildProviderGenerationParams(provider, payload.generation_params, ollamaRuntime);
        const result = await invokeProviderGenerate(provider, {
          model: resolvedModel,
          inputText: preparedInputText,
          generationParams,
        }, apiKey ?? '', controller.signal, {
          onTextDelta: (deltaText) => writeNdjson(res, { type: 'delta', deltaText }),
        });
        const citationResult = await processResponseCitations({
          outputText: result.outputText,
          sources: normalizedSources,
          sourceCitationEnabled: citationRequested && normalizedSources.length > 0,
          retryCanonicalize: citationRequested && normalizedSources.length > 0
            ? async () => {
              const retryPass = await invokeProviderGenerate(provider, {
                model: resolvedModel,
                inputText: [
                  preparedInputText,
                  '',
                  'Retry pass: use canonical citation format [n].',
                  'Every [n] must map to an existing source index from tool_outputs.',
                  'Do not fabricate citations.',
                ].join('\n'),
                generationParams,
              }, apiKey ?? '', controller.signal);
              return retryPass.outputText;
            }
            : undefined,
        });
        const outputText = citationResult.outputText;
        appendAgentActivityLog({
          timestamp: new Date().toISOString(),
          note_id: String(payload.note_id ?? ''),
          action: 'generate',
          trigger_source: String(payload.trigger_source ?? 'manual'),
          initiated_by: String(payload.initiated_by ?? 'user'),
          provider,
          model: resolvedModel,
          status: 'success',
          duration_ms: Date.now() - startedAt,
          input_chars: inputText.length,
          output_chars: outputText.length,
          token_estimate: result.usage?.totalTokens ?? null,
          cost_estimate_usd: result.costEstimate ?? null,
          error_message_short: null,
          search_warning: searchWarningMessage ? 1 : 0,
          search_warning_message: searchWarningMessage,
          web_search_enabled: normalizedWebSearchConfig.enabled ? 1 : 0,
          tool_calls_attempted: toolCallsAttempted,
          tool_calls_succeeded: toolCallsSucceeded,
          search_query_count: queryCount,
          source_count: sourceCount,
          tool_failure_reason: toolFailureReason,
          citation_events_json: citationResult.citationEvents.length > 0 ? JSON.stringify(citationResult.citationEvents) : null,
        });
        webSearchMetadata.queryCount = queryCount;
        webSearchMetadata.sourceCount = sourceCount;
        writeNdjson(res, { type: 'done', ...result, outputText, web_search: webSearchMetadata });
        emitStructuredLog('agent.generate.completed', {
          correlation_id: actionCorrelationId,
          action: 'generate',
          turn_latency_ms: Date.now() - startedAt,
          stream_status: 'done',
          search_query_count: queryCount,
          source_count: sourceCount,
        });
        res.end();
      } catch (error) {
        const cancelled = clientAborted;
        const errorMessage = error instanceof Error ? error.message : 'Generation failed.';
        emitStructuredLog('agent.generate.stream_error', {
          correlation_id: actionCorrelationId,
          action: 'generate',
          turn_latency_ms: Date.now() - startedAt,
          cancelled,
          message: errorMessage,
        });
        appendAgentActivityLog({
          timestamp: new Date().toISOString(),
          note_id: String(payload.note_id ?? ''),
          action: 'generate',
          trigger_source: String(payload.trigger_source ?? 'manual'),
          initiated_by: String(payload.initiated_by ?? 'user'),
          provider,
          model: resolvedModel,
          status: cancelled ? 'cancelled' : 'failed',
          duration_ms: Date.now() - startedAt,
          input_chars: inputText.length,
          output_chars: 0,
          token_estimate: null,
          cost_estimate_usd: null,
          error_message_short: errorMessage.slice(0, 180),
          search_warning: 0,
          search_warning_message: null,
          web_search_enabled: settings.generation_params?.web_search?.enabled ? 1 : 0,
          tool_calls_attempted: toolCallsAttempted,
          tool_calls_succeeded: toolCallsSucceeded,
          search_query_count: queryCount,
          source_count: sourceCount,
          tool_failure_reason: toolFailureReason ?? errorMessage.slice(0, 180),
          citation_events_json: null,
        });
        if (res.headersSent) {
          writeNdjson(res, { type: 'error', message: cancelled ? 'Generation cancelled.' : errorMessage, aborted: cancelled });
          res.end();
        } else {
          writeJson(res, cancelled ? 499 : 400, { error: { message: cancelled ? 'Generation cancelled.' : errorMessage } });
        }
      }
      return true;
    }

    if (req.method === 'GET' && url === '/api/research-tasks') {
      const tasks = queryJson<NewResearchTaskRow>('select * from new_research_tasks order by created_at desc').map(normalizeTaskRow);
      writeJson(res, 200, tasks);
      return true;
    }

    if (req.method === 'GET' && /^\/api\/research-tasks\/[^/]+\/activity$/.test(url)) {
      const taskId = url.replace('/api/research-tasks/', '').replace('/activity', '').trim();
      const activity = queryJson<TaskActivityRow>(`select * from task_activity_events where task_id = ${sqlEscape(taskId)} order by created_at desc`);
      writeJson(res, 200, activity);
      return true;
    }

    if (req.method === 'POST' && url === '/api/research-tasks') {
      const payload = await readJsonBody(req);
      const actionCorrelationId = randomUUID();
      const ticker = String(payload.ticker ?? '').trim().toUpperCase();
      if (!ticker) {
        writeJson(res, 400, { error: { message: 'Ticker is required.' } });
        return true;
      }
      const priority = String(payload.priority ?? '').trim().toLowerCase();
      const normalizedPriority = VALID_TASK_PRIORITIES.has(priority) ? priority : '';
      const now = new Date().toISOString();
      const id = randomUUID();
      const noteType = String(payload.note_type ?? '').trim();
      execSql(`insert into new_research_tasks (id, title, details, ticker, note_type, assignee, priority, deadline, status, date_completed, archived, linked_note_file_id, linked_note_path, research_location_folder_id, research_location_path, created_at, updated_at) values (${sqlEscape(id)}, ${sqlEscape(payload.title ?? '')}, ${sqlEscape(payload.details ?? '')}, ${sqlEscape(ticker)}, ${sqlEscape(noteType)}, ${sqlEscape(payload.assignee ?? '')}, ${sqlEscape(normalizedPriority)}, ${sqlEscape(payload.deadline ?? '')}, ${sqlEscape(payload.status ?? 'ideas')}, ${sqlEscape(payload.date_completed ?? '')}, ${sqlEscape(payload.archived ? 1 : 0)}, ${sqlEscape(payload.linked_note_file_id ?? '')}, ${sqlEscape(payload.linked_note_path ?? '')}, ${sqlEscape(payload.research_location_folder_id ?? '')}, ${sqlEscape(payload.research_location_path ?? '')}, ${sqlEscape(now)}, ${sqlEscape(now)})`);
      recordTaskEvent(id, 'create', 'Task created.');
      const created = queryJson<NewResearchTaskRow>(`select * from new_research_tasks where id = ${sqlEscape(id)} limit 1`)[0];
      emitStructuredLog('task.create.outcome', {
        correlation_id: actionCorrelationId,
        action: 'create',
        task_id: id,
        status: 'success',
      });
      writeJson(res, 200, normalizeTaskRow(created));
      return true;
    }

    if (req.method === 'PATCH' && url.startsWith('/api/research-tasks/')) {
      const taskId = url.replace('/api/research-tasks/', '').trim();
      const actionCorrelationId = randomUUID();
      const payload = await readJsonBody(req);
      const existing = queryJson<NewResearchTaskRow>(`select * from new_research_tasks where id = ${sqlEscape(taskId)} limit 1`)[0];
      if (!existing) {
        writeJson(res, 404, { error: { message: 'Task not found.' } });
        return true;
      }
      const ticker = String(payload.ticker ?? existing.ticker).trim().toUpperCase();
      if (!ticker) {
        writeJson(res, 400, { error: { message: 'Ticker is required.' } });
        return true;
      }
      const nextLinkedFile = String(payload.linked_note_file_id ?? existing.linked_note_file_id).trim();
      if (nextLinkedFile) {
        const linkOwner = queryJson<Pick<NewResearchTaskRow, 'id'>>(`select id from new_research_tasks where linked_note_file_id = ${sqlEscape(nextLinkedFile)} and id != ${sqlEscape(taskId)} limit 1`)[0];
        if (linkOwner) {
          writeJson(res, 409, { error: { message: 'That note is already linked to another task. Task↔note links must stay one-to-one.' } });
          return true;
        }
      }
      const nextPriority = String(payload.priority ?? existing.priority).trim().toLowerCase();
      const normalizedPriority = VALID_TASK_PRIORITIES.has(nextPriority) ? nextPriority : '';
      const noteType = String(payload.note_type ?? existing.note_type).trim();
      execSql(`update new_research_tasks set
        title = ${sqlEscape(payload.title ?? existing.title)},
        details = ${sqlEscape(payload.details ?? existing.details)},
        ticker = ${sqlEscape(ticker)},
        note_type = ${sqlEscape(noteType)},
        assignee = ${sqlEscape(payload.assignee ?? existing.assignee)},
        priority = ${sqlEscape(normalizedPriority)},
        deadline = ${sqlEscape(payload.deadline ?? existing.deadline)},
        status = ${sqlEscape(payload.status ?? existing.status)},
        date_completed = ${sqlEscape(payload.date_completed ?? existing.date_completed)},
        archived = ${sqlEscape(payload.archived === undefined ? existing.archived : payload.archived ? 1 : 0)},
        linked_note_file_id = ${sqlEscape(nextLinkedFile)},
        linked_note_path = ${sqlEscape(payload.linked_note_path ?? existing.linked_note_path)},
        research_location_folder_id = ${sqlEscape(payload.research_location_folder_id ?? existing.research_location_folder_id)},
        research_location_path = ${sqlEscape(payload.research_location_path ?? existing.research_location_path)},
        updated_at = ${sqlEscape(new Date().toISOString())}
        where id = ${sqlEscape(taskId)}`);
      const changedFields: string[] = [];
      if (String(payload.title ?? existing.title) !== existing.title) changedFields.push('title');
      if (String(payload.details ?? existing.details) !== existing.details) changedFields.push('details');
      if (ticker !== existing.ticker) changedFields.push('ticker');
      if (noteType !== existing.note_type) changedFields.push('note type');
      if (normalizedPriority !== existing.priority) changedFields.push('priority');
      if (String(payload.deadline ?? existing.deadline) !== existing.deadline) changedFields.push('deadline');
      if (String(payload.date_completed ?? existing.date_completed) !== existing.date_completed) changedFields.push('completion date');

      const nextStatus = String(payload.status ?? existing.status);
      if (nextStatus !== existing.status) recordTaskEvent(taskId, 'status', `Status changed: ${existing.status} → ${nextStatus}.`);
      const nextAssignee = String(payload.assignee ?? existing.assignee);
      if (nextAssignee !== existing.assignee) recordTaskEvent(taskId, 'assignee', `Assignee changed: ${existing.assignee || '—'} → ${nextAssignee || '—'}.`);
      if (normalizedPriority !== existing.priority) recordTaskEvent(taskId, 'priority', `Priority changed: ${existing.priority || '—'} → ${normalizedPriority || '—'}.`);
      const nextLinked = nextLinkedFile;
      if (!existing.linked_note_file_id && nextLinked) {
        recordTaskEvent(taskId, 'link', `Linked note: ${String(payload.linked_note_path ?? existing.linked_note_path) || nextLinked}.`);
      } else if (existing.linked_note_file_id && !nextLinked) {
        recordTaskEvent(taskId, 'unlink', 'Unlinked note.');
      } else if (existing.linked_note_file_id && nextLinked !== existing.linked_note_file_id) {
        recordTaskEvent(taskId, 'link', `Relinked note: ${String(payload.linked_note_path ?? existing.linked_note_path) || nextLinked}.`);
      }
      const nextArchived = payload.archived === undefined ? Boolean(existing.archived) : Boolean(payload.archived);
      if (nextArchived !== Boolean(existing.archived)) recordTaskEvent(taskId, nextArchived ? 'archive' : 'unarchive', nextArchived ? 'Task archived.' : 'Task unarchived.');
      if (changedFields.length > 0) recordTaskEvent(taskId, 'edit', `Updated ${changedFields.join(', ')}.`);

      const updated = queryJson<NewResearchTaskRow>(`select * from new_research_tasks where id = ${sqlEscape(taskId)} limit 1`)[0];
      emitStructuredLog('task.update.outcome', {
        correlation_id: actionCorrelationId,
        action: nextArchived !== Boolean(existing.archived) && nextArchived ? 'archive' : 'update',
        task_id: taskId,
        status: 'success',
        changed_fields: changedFields,
      });
      writeJson(res, 200, normalizeTaskRow(updated));
      return true;
    }

    if (req.method === 'DELETE' && url.startsWith('/api/research-tasks/')) {
      const taskId = url.replace('/api/research-tasks/', '').trim();
      const existing = queryJson<Pick<NewResearchTaskRow, 'id'>>(`select id from new_research_tasks where id = ${sqlEscape(taskId)} limit 1`)[0];
      if (!existing) {
        writeJson(res, 404, { error: { message: 'Task not found.' } });
        return true;
      }
      execSql(`
        begin;
        delete from attachment_links where link_type = 'task' and link_id = ${sqlEscape(taskId)};
        delete from task_activity_events where task_id = ${sqlEscape(taskId)};
        delete from new_research_tasks where id = ${sqlEscape(taskId)};
        commit;
      `);
      execSql(`update attachments set deleted_at = ${sqlEscape(new Date().toISOString())} where id in (select a.id from attachments a left join attachment_links l on l.attachment_id = a.id where l.id is null and a.deleted_at is null)`);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'POST' && url === '/api/folders') {
      const payload = await readJsonBody(req);
      const now = new Date().toISOString();
      execSql(`insert into folders (id, workspace_id, parent_id, name, path, created_at, updated_at) values (${sqlEscape(randomUUID())}, ${sqlEscape(payload.workspaceId)}, ${sqlEscape(payload.parentId)}, ${sqlEscape(payload.name)}, ${sqlEscape(payload.path)}, ${sqlEscape(now)}, ${sqlEscape(now)})`);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'PATCH' && url.startsWith('/api/folders/')) {
      const folderId = url.replace('/api/folders/', '').trim();
      const payload = await readJsonBody(req);
      execSql(`update folders set name = ${sqlEscape(payload.name)}, path = ${sqlEscape(payload.path)}, updated_at = ${sqlEscape(new Date().toISOString())} where id = ${sqlEscape(folderId)}`);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'DELETE' && url.startsWith('/api/folders/')) {
      const folderId = url.replace('/api/folders/', '').trim();
      execSql(`delete from folders where id = ${sqlEscape(folderId)}`);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'POST' && url === '/api/files') {
      const payload = await readJsonBody(req);
      const now = new Date().toISOString();
      execSql(`insert into research_notes (id, workspace_id, folder_id, name, path, content, frontmatter_json, is_template, created_at, updated_at) values (${sqlEscape(randomUUID())}, ${sqlEscape(payload.workspaceId)}, ${sqlEscape(payload.folderId)}, ${sqlEscape(payload.name)}, ${sqlEscape(payload.path)}, ${sqlEscape(payload.content)}, ${sqlEscape(payload.frontmatter ? JSON.stringify(payload.frontmatter) : null)}, ${sqlEscape(payload.isTemplate ? 1 : 0)}, ${sqlEscape(now)}, ${sqlEscape(now)})`);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'PATCH' && url.startsWith('/api/files/')) {
      const fileId = url.replace('/api/files/', '').trim();
      const payload = await readJsonBody(req);
      const existing = queryJson<ResearchNoteRow>(`select * from research_notes where id = ${sqlEscape(fileId)} limit 1`)[0];
      if (!existing) {
        writeJson(res, 404, { error: { message: 'File not found.' } });
        return true;
      }
      const nextPath = String(payload.path ?? existing.path);
      const pathChanged = nextPath !== existing.path;
      const now = new Date().toISOString();
      const linkedTasks = pathChanged
        ? queryJson<Pick<NewResearchTaskRow, 'id'>>(`select id from new_research_tasks where linked_note_file_id = ${sqlEscape(fileId)}`)
        : [];

      execSql(`update research_notes set
        name = ${sqlEscape(payload.name ?? existing.name)},
        path = ${sqlEscape(nextPath)},
        folder_id = ${payload.folder_id === undefined ? sqlEscape(existing.folder_id) : sqlEscape(payload.folder_id)},
        content = ${sqlEscape(payload.content ?? existing.content)},
        frontmatter_json = ${payload.frontmatter_json === undefined ? sqlEscape(existing.frontmatter_json) : sqlEscape(payload.frontmatter_json ? JSON.stringify(payload.frontmatter_json) : null)},
        is_template = ${payload.is_template === undefined ? sqlEscape(existing.is_template) : sqlEscape(payload.is_template ? 1 : 0)},
        updated_at = ${sqlEscape(now)}
        where id = ${sqlEscape(fileId)}`);

      if (pathChanged) {
        execSql(`update new_research_tasks set linked_note_path = ${sqlEscape(nextPath)}, updated_at = ${sqlEscape(now)} where linked_note_file_id = ${sqlEscape(fileId)}`);
        linkedTasks.forEach((task) => {
          recordTaskEvent(task.id, 'link_path_sync', `Linked note path synced to ${nextPath}.`);
        });
      }
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'DELETE' && url.startsWith('/api/files/')) {
      const fileId = url.replace('/api/files/', '').trim();
      const now = new Date().toISOString();
      const linkedTasks = queryJson<Pick<NewResearchTaskRow, 'id'>>(`select id from new_research_tasks where linked_note_file_id = ${sqlEscape(fileId)}`);
      if (linkedTasks.length > 0) {
        execSql(`update new_research_tasks set linked_note_file_id = '', linked_note_path = '', updated_at = ${sqlEscape(now)} where linked_note_file_id = ${sqlEscape(fileId)}`);
        linkedTasks.forEach((task) => {
          recordTaskEvent(task.id, 'unlink', 'Unlinked note because the linked note was deleted.');
        });
      }
      execSql(`delete from attachment_links where link_type = 'note' and link_id = ${sqlEscape(fileId)}`);
      execSql(`update attachments set deleted_at = ${sqlEscape(new Date().toISOString())} where id in (select a.id from attachments a left join attachment_links l on l.attachment_id = a.id where l.id is null and a.deleted_at is null)`);
      execSql(`delete from research_notes where id = ${sqlEscape(fileId)}`);
      writeJson(res, 200, { error: null });
      return true;
    }
  } catch (error) {
    writeJson(res, 400, { error: { message: error instanceof Error ? error.message : 'Request failed.' } });
    return true;
  }

  return false;
}
