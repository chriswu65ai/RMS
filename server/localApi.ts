import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type WorkspaceRow = { id: string; name: string; created_at: string; updated_at: string };
type FolderRow = { id: string; workspace_id: string; parent_id: string | null; name: string; path: string; created_at: string; updated_at: string };
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
  `);
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
  const researchFolderId = randomUUID();
  const templatesFolderId = randomUUID();

  execSql(`
begin;
insert into workspaces (id, name, created_at, updated_at) values (${sqlEscape(workspaceId)}, 'Workspace', ${sqlEscape(now)}, ${sqlEscape(now)});
insert into folders (id, workspace_id, parent_id, name, path, created_at, updated_at) values (${sqlEscape(researchFolderId)}, ${sqlEscape(workspaceId)}, NULL, 'Research', 'Research', ${sqlEscape(now)}, ${sqlEscape(now)});
insert into folders (id, workspace_id, parent_id, name, path, created_at, updated_at) values (${sqlEscape(templatesFolderId)}, ${sqlEscape(workspaceId)}, NULL, 'Templates', 'Templates', ${sqlEscape(now)}, ${sqlEscape(now)});
insert into prompt_files (id, workspace_id, folder_id, name, path, content, frontmatter_json, is_template, created_at, updated_at)
values (${sqlEscape(randomUUID())}, ${sqlEscape(workspaceId)}, ${sqlEscape(researchFolderId)}, 'weekly-research.md', 'Research/weekly-research.md', ${sqlEscape(`---\ntitle: Weekly Research\nsectors: [research, finance]\nrecommendation: hold\nstock_recommendation: hold\n---\n# Weekly Stock Research\nSummarize the key market themes for this week.`)}, ${sqlEscape('{"title":"Weekly Research","sectors":["research","finance"],"recommendation":"hold","stock_recommendation":"hold"}')}, 0, ${sqlEscape(now)}, ${sqlEscape(now)});
insert into prompt_files (id, workspace_id, folder_id, name, path, content, frontmatter_json, is_template, created_at, updated_at)
values (${sqlEscape(randomUUID())}, ${sqlEscape(workspaceId)}, ${sqlEscape(templatesFolderId)}, 'research-template.md', 'Templates/research-template.md', ${sqlEscape(`---\ntitle: Weekly Research\ntemplate: true\nsectors: [research]\nrecommendation: ''\nstock_recommendation: ''\n---\n# Weekly Stock Research\n## Context\n## Questions\n## Deliverable`)}, ${sqlEscape('{"title":"Weekly Research","template":true,"sectors":["research"],"recommendation":"","stock_recommendation":""}')}, 1, ${sqlEscape(now)}, ${sqlEscape(now)});
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

export async function handleLocalApiRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '';
  ensureInitialized();

  if (req.method === 'GET' && url === '/api/bootstrap') {
    const workspace = ensureWorkspaceWithStarterContent();
    writeJson(res, 200, listWorkspaceData(workspace.id));
    return true;
  }

  try {
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

      execSql(`update prompt_files set
        name = ${sqlEscape(payload.name ?? existing.name)},
        path = ${sqlEscape(payload.path ?? existing.path)},
        folder_id = ${payload.folder_id === undefined ? sqlEscape(existing.folder_id) : sqlEscape(payload.folder_id)},
        content = ${sqlEscape(payload.content ?? existing.content)},
        frontmatter_json = ${payload.frontmatter_json === undefined ? sqlEscape(existing.frontmatter_json) : sqlEscape(payload.frontmatter_json ? JSON.stringify(payload.frontmatter_json) : null)},
        is_template = ${payload.is_template === undefined ? sqlEscape(existing.is_template) : sqlEscape(payload.is_template ? 1 : 0)},
        updated_at = ${sqlEscape(new Date().toISOString())}
        where id = ${sqlEscape(fileId)}`);
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
