import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FALLBACK_MODELS, providerRegistry, selectBestModel, supportsToolCalling, type AgentProvider } from './agentProviders';
import { type SearchResult } from './searchProviders';
import { runAgentToolOrchestration } from './agentToolOrchestrator';
import { processResponseCitations } from './response/citation_pipeline';
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

const dbPath = process.env.SQLITE_PATH ?? path.resolve(process.cwd(), 'data/researchmanager.db');
mkdirSync(path.dirname(dbPath), { recursive: true });
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
  `);
  execSql(`insert or ignore into agent_settings (id, default_provider, default_model, generation_params_json) values (1, 'minimax', '', null);`);
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

const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
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

const OLLAMA_BASE_URL_DEFAULT = 'http://localhost:11434';

const WEB_SEARCH_PROVIDER_DEFAULT: WebSearchProvider = 'duckduckgo';
const WEB_SEARCH_MODE_DEFAULT: WebSearchMode = 'single';
const WEB_SEARCH_RECENCY_DEFAULT: WebSearchRecency = 'any';
const WEB_SEARCH_DOMAIN_POLICY_DEFAULT: WebSearchDomainPolicy = 'open_web';
const WEB_SEARCH_MAX_RESULTS_DEFAULT = 5;
const WEB_SEARCH_TIMEOUT_MS_DEFAULT = 5000;
const WEB_SEARCH_SAFE_SEARCH_DEFAULT = true;
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
  domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  domain = domain.replace(/^\/\//, '');
  domain = domain.split(/[/?#]/, 1)[0] ?? '';
  domain = domain.replace(/:\d+$/, '');
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

export async function handleLocalApiRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '';
  ensureInitialized();

  if (req.method === 'GET' && url === '/api/bootstrap') {
    const workspace = ensureWorkspaceWithStarterContent();
    writeJson(res, 200, listWorkspaceData(workspace.id));
    return true;
  }

  try {
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
        writeJson(res, 400, {
          error: {
            message: `Web search requires tool calling support. Select a tool-capable model for ${provider} (current: ${defaultModel || 'not selected'}), or disable web search.`,
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

      const result = await providerRegistry[provider].listModels(apiKey ?? '', { fallbackModels, preferredModel, baseUrl: ollamaRuntime.baseUrl });
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

    if (req.method === 'POST' && url === '/api/agent/generate') {
      const payload = await readJsonBody(req);
      const provider = payload.provider;
      if (!isAgentProvider(provider)) {
        writeJson(res, 400, { error: { message: 'Invalid provider.' } });
        return true;
      }
      const model = String(payload.model ?? '').trim();
      const inputText = String(payload.input_text ?? '');
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
      req.on('aborted', () => controller.abort());
      beginNdjson(res);
      writeNdjson(res, { type: 'status', stage: 'started' });
      try {
        const preferredSources = queryJson<PreferredSourceRow>('select * from preferred_sources where enabled = 1 order by weight desc, domain asc');
        const normalizedWebSearchConfig = settings.generation_params?.web_search ?? {
          enabled: false,
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
          queryCount: 0,
          sourceCount: 0,
        };
        let normalizedSources: ReturnType<typeof normalizeStreamingSources> = [];
        let preparedInputText = inputText;
        let toolCallsAttempted = 0;
        let toolCallsSucceeded = 0;
        let toolFailureReason: string | null = null;
        if (normalizedWebSearchConfig.enabled) {
          const orchestration = await runAgentToolOrchestration({
            provider,
            model: resolvedModel,
            inputText,
            apiKey: apiKey ?? '',
            baseUrl: provider === 'ollama' ? ollamaRuntime.baseUrl : undefined,
            settings: normalizedWebSearchConfig,
            preferredSources: preferredSources.map((source) => ({ domain: source.domain, weight: source.weight })),
            signal: controller.signal,
            onEvent: (event) => writeNdjson(res, { type: event.type, ...event }),
          });
          normalizedSources = normalizeStreamingSources(orchestration.allSources);
          webSearchMetadata.queryCount = orchestration.queryCount;
          webSearchMetadata.sourceCount = orchestration.sourceCount;
          toolCallsAttempted = orchestration.toolCallsAttempted;
          toolCallsSucceeded = orchestration.toolCallsSucceeded;
          toolFailureReason = orchestration.toolFailureReason;
          preparedInputText = orchestration.consumedInputText;
        }
        if (normalizedSources.length > 0) {
          writeNdjson(res, { type: 'sources', sources: normalizedSources });
        }
        const result = await providerRegistry[provider].generate({
          model: resolvedModel,
          inputText: preparedInputText,
          generationParams: {
            ...(payload.generation_params as { temperature?: number; maxTokens?: number } | undefined),
            ...(provider === 'ollama' ? { baseUrl: ollamaRuntime.baseUrl } : {}),
          },
        }, apiKey ?? '', controller.signal, {
          onTextDelta: (deltaText) => writeNdjson(res, { type: 'delta', deltaText }),
        });
        const citationResult = await processResponseCitations({
          outputText: result.outputText,
          sources: normalizedSources,
          sourceCitationEnabled: normalizedWebSearchConfig.source_citation && normalizedSources.length > 0,
          retryCanonicalize: normalizedWebSearchConfig.source_citation && normalizedSources.length > 0
            ? async () => {
              const retryPass = await providerRegistry[provider].generate({
                model: resolvedModel,
                inputText: [
                  preparedInputText,
                  '',
                  'Retry pass: use canonical citation format [n].',
                  'Every [n] must map to an existing source index from tool_outputs.',
                  'Do not fabricate citations.',
                ].join('\n'),
                generationParams: {
                  ...(payload.generation_params as { temperature?: number; maxTokens?: number } | undefined),
                  ...(provider === 'ollama' ? { baseUrl: ollamaRuntime.baseUrl } : {}),
                },
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
          search_warning: 0,
          search_warning_message: null,
          web_search_enabled: normalizedWebSearchConfig.enabled ? 1 : 0,
          tool_calls_attempted: toolCallsAttempted,
          tool_calls_succeeded: toolCallsSucceeded,
          search_query_count: webSearchMetadata.queryCount,
          source_count: webSearchMetadata.sourceCount,
          tool_failure_reason: toolFailureReason,
          citation_events_json: citationResult.citationEvents.length > 0 ? JSON.stringify(citationResult.citationEvents) : null,
        });
        writeNdjson(res, { type: 'done', ...result, outputText, web_search: webSearchMetadata });
        res.end();
      } catch (error) {
        const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        appendAgentActivityLog({
          timestamp: new Date().toISOString(),
          note_id: String(payload.note_id ?? ''),
          action: 'generate',
          trigger_source: String(payload.trigger_source ?? 'manual'),
          initiated_by: String(payload.initiated_by ?? 'user'),
          provider,
          model: resolvedModel,
          status: aborted ? 'cancelled' : 'failed',
          duration_ms: Date.now() - startedAt,
          input_chars: inputText.length,
          output_chars: 0,
          token_estimate: null,
          cost_estimate_usd: null,
          error_message_short: error instanceof Error ? error.message.slice(0, 180) : 'Generation failed.',
          search_warning: 0,
          search_warning_message: null,
          web_search_enabled: settings.generation_params?.web_search?.enabled ? 1 : 0,
          tool_calls_attempted: 0,
          tool_calls_succeeded: 0,
          search_query_count: 0,
          source_count: 0,
          tool_failure_reason: error instanceof Error ? error.message.slice(0, 180) : 'Generation failed.',
          citation_events_json: null,
        });
        if (res.headersSent) {
          writeNdjson(res, { type: 'error', message: aborted ? 'Generation cancelled.' : (error instanceof Error ? error.message : 'Generation failed.'), aborted });
          res.end();
        } else {
          writeJson(res, aborted ? 499 : 400, { error: { message: aborted ? 'Generation cancelled.' : (error instanceof Error ? error.message : 'Generation failed.') } });
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
      writeJson(res, 200, normalizeTaskRow(created));
      return true;
    }

    if (req.method === 'PATCH' && url.startsWith('/api/research-tasks/')) {
      const taskId = url.replace('/api/research-tasks/', '').trim();
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
        delete from task_activity_events where task_id = ${sqlEscape(taskId)};
        delete from new_research_tasks where id = ${sqlEscape(taskId)};
        commit;
      `);
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
