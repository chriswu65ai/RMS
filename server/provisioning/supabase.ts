import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Pending = {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  message: string;
  createdAt: string;
  completedAt?: string;
  result?: {
    projectRef: string;
    projectUrl?: string;
    anonKey?: string;
  };
};

type ProvisioningPayload = {
  projectRef?: string;
  projectUrl?: string;
  createProject?: {
    organizationId: string;
    name: string;
    region?: string;
    plan?: string;
    dbPass?: string;
  };
  devAccessToken?: string;
};

type ListProjectsPayload = {
  organizationId?: string;
  devAccessToken?: string;
};

const operations = new Map<string, Pending>();

function extractProjectRef(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    if (!host.endsWith('.supabase.co')) return null;
    return host.split('.')[0] ?? null;
  } catch {
    return null;
  }
}

function canUseDevPat() {
  return process.env.SUPABASE_ALLOW_DEV_PAT === 'true' || process.env.NODE_ENV !== 'production';
}

function resolveManagementToken(payload: { devAccessToken?: string }): string {
  const envPat = process.env.SUPABASE_MANAGEMENT_PAT;
  if (envPat) return envPat;
  if (canUseDevPat() && payload.devAccessToken) return payload.devAccessToken;
  throw new Error('Management PAT is not configured on backend.');
}

async function supabaseApi<T>(apiPath: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.supabase.com/v1${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaInstallerPath = path.resolve(__dirname, '../../supabase/installer/schema.sql');

async function loadSchemaInstallerSql() {
  const sql = await readFile(schemaInstallerPath, 'utf8').catch(() => null);
  if (!sql) {
    throw new Error('Missing supabase/installer/schema.sql. Run `npm run build:schema-installer`.');
  }

  return sql;
}

async function waitForProjectReady(projectRef: string, token: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const project = await supabaseApi<{ id: string; status?: string }>(`/projects/${projectRef}`, token);
    if (project.status === 'ACTIVE' || project.status === 'HEALTHY') return;
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
}

async function getProjectConnection(projectRef: string, token: string) {
  const apiKeys = await supabaseApi<Array<{ api_key: string; name: string }>>(`/projects/${projectRef}/api-keys`, token);
  const anon = apiKeys.find((item) => item.name.toLowerCase().includes('anon'));

  return {
    projectRef,
    projectUrl: `https://${projectRef}.supabase.co`,
    anonKey: anon?.api_key,
  };
}

async function createProjectIfRequested(payload: ProvisioningPayload, token: string) {
  if (!payload.createProject) {
    const providedRef = payload.projectRef ?? (payload.projectUrl ? extractProjectRef(payload.projectUrl) : null);
    if (!providedRef) {
      throw new Error('A projectRef or projectUrl is required when createProject is not requested.');
    }

    await waitForProjectReady(providedRef, token);
    return getProjectConnection(providedRef, token);
  }

  const created = await supabaseApi<{ id: string }>('/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      organization_id: payload.createProject.organizationId,
      name: payload.createProject.name,
      region: payload.createProject.region ?? 'us-east-1',
      plan: payload.createProject.plan,
      db_pass: payload.createProject.dbPass,
    }),
  });

  await waitForProjectReady(created.id, token);
  return getProjectConnection(created.id, token);
}

async function installSchema(projectRef: string, token: string): Promise<void> {
  const installerSql = await loadSchemaInstallerSql();

  await supabaseApi(`/projects/${projectRef}/database/query`, token, {
    method: 'POST',
    body: JSON.stringify({ query: installerSql }),
  });
}

async function runProvisioning(operationId: string, payload: ProvisioningPayload) {
  const state = operations.get(operationId);
  if (!state) return;

  state.status = 'running';
  state.message = 'Provisioning Supabase project and applying canonical migrations...';

  try {
    const token = resolveManagementToken(payload);
    const project = await createProjectIfRequested(payload, token);
    await installSchema(project.projectRef, token);

    state.status = 'succeeded';
    state.message = 'Provisioning complete.';
    state.completedAt = new Date().toISOString();
    state.result = project;
  } catch (error) {
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.message = error instanceof Error ? error.message : 'Unknown provisioning error.';
  }
}

export async function listSupabaseProjects(payload: ListProjectsPayload) {
  const token = resolveManagementToken(payload);
  const projects = await supabaseApi<Array<{ id: string; name: string; organization_id: string; region?: string; status?: string }>>('/projects', token);

  return projects
    .filter((project) => !payload.organizationId || project.organization_id === payload.organizationId)
    .map((project) => ({
      id: project.id,
      name: project.name,
      organizationId: project.organization_id,
      region: project.region,
      status: project.status,
    }));
}

export function startSupabaseProvisioning(payload: ProvisioningPayload) {
  const id = randomUUID();
  operations.set(id, {
    id,
    status: 'pending',
    message: 'Provisioning request accepted.',
    createdAt: new Date().toISOString(),
  });

  void runProvisioning(id, payload);
  return { operationId: id };
}

export function getSupabaseProvisioningStatus(operationId: string) {
  return operations.get(operationId) ?? null;
}
