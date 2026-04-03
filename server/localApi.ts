import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type WorkspaceRow = { id: string; name: string; created_at: string; updated_at: string };
type FolderRow = { id: string; workspace_id: string; parent_id: string | null; name: string; path: string; created_at: string; updated_at: string };

type NewResearchTaskRow = {
  id: string;
  topic: string;
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

type PromptFileRow = {
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
  create table if not exists prompt_files (
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
    topic text not null default '',
    details text not null default '',
    ticker text not null,
    note_type text not null default 'Research',
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
  `);
  try {
    execSql(`alter table new_research_tasks add column note_type text not null default 'Research';`);
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
  initialized = true;
};

const writeJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
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
  const files = queryJson<PromptFileRow>(`select * from prompt_files where workspace_id = ${sqlEscape(workspaceId)} order by path`).map((file) => ({
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

export async function handleLocalApiRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '';
  ensureInitialized();

  if (req.method === 'GET' && url === '/api/bootstrap') {
    const workspace = ensureWorkspaceWithStarterContent();
    writeJson(res, 200, listWorkspaceData(workspace.id));
    return true;
  }

  try {
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
      execSql(`insert into new_research_tasks (id, topic, details, ticker, note_type, assignee, priority, deadline, status, date_completed, archived, linked_note_file_id, linked_note_path, research_location_folder_id, research_location_path, created_at, updated_at) values (${sqlEscape(id)}, ${sqlEscape(payload.topic ?? '')}, ${sqlEscape(payload.details ?? '')}, ${sqlEscape(ticker)}, ${sqlEscape(payload.note_type ?? 'Research')}, ${sqlEscape(payload.assignee ?? '')}, ${sqlEscape(normalizedPriority)}, ${sqlEscape(payload.deadline ?? '')}, ${sqlEscape(payload.status ?? 'ideas')}, ${sqlEscape(payload.date_completed ?? '')}, ${sqlEscape(payload.archived ? 1 : 0)}, ${sqlEscape(payload.linked_note_file_id ?? '')}, ${sqlEscape(payload.linked_note_path ?? '')}, ${sqlEscape(payload.research_location_folder_id ?? '')}, ${sqlEscape(payload.research_location_path ?? '')}, ${sqlEscape(now)}, ${sqlEscape(now)})`);
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
      execSql(`update new_research_tasks set
        topic = ${sqlEscape(payload.topic ?? existing.topic)},
        details = ${sqlEscape(payload.details ?? existing.details)},
        ticker = ${sqlEscape(ticker)},
        note_type = ${sqlEscape(payload.note_type ?? existing.note_type)},
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
      if (String(payload.topic ?? existing.topic) !== existing.topic) changedFields.push('topic');
      if (String(payload.details ?? existing.details) !== existing.details) changedFields.push('details');
      if (ticker !== existing.ticker) changedFields.push('ticker');
      if (String(payload.note_type ?? existing.note_type) !== existing.note_type) changedFields.push('note type');
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
      execSql(`delete from new_research_tasks where id = ${sqlEscape(taskId)}`);
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
      execSql(`insert into prompt_files (id, workspace_id, folder_id, name, path, content, frontmatter_json, is_template, created_at, updated_at) values (${sqlEscape(randomUUID())}, ${sqlEscape(payload.workspaceId)}, ${sqlEscape(payload.folderId)}, ${sqlEscape(payload.name)}, ${sqlEscape(payload.path)}, ${sqlEscape(payload.content)}, ${sqlEscape(payload.frontmatter ? JSON.stringify(payload.frontmatter) : null)}, ${sqlEscape(payload.isTemplate ? 1 : 0)}, ${sqlEscape(now)}, ${sqlEscape(now)})`);
      writeJson(res, 200, { error: null });
      return true;
    }

    if (req.method === 'PATCH' && url.startsWith('/api/files/')) {
      const fileId = url.replace('/api/files/', '').trim();
      const payload = await readJsonBody(req);
      const existing = queryJson<PromptFileRow>(`select * from prompt_files where id = ${sqlEscape(fileId)} limit 1`)[0];
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

      execSql(`update prompt_files set
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
      execSql(`delete from prompt_files where id = ${sqlEscape(fileId)}`);
      writeJson(res, 200, { error: null });
      return true;
    }
  } catch (error) {
    writeJson(res, 400, { error: { message: error instanceof Error ? error.message : 'Request failed.' } });
    return true;
  }

  return false;
}
