const MIGRATION_SQL = `
create extension if not exists "pgcrypto";

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  parent_id uuid references folders(id) on delete set null,
  name text not null,
  path text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(workspace_id, path)
);

create table if not exists prompt_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  folder_id uuid references folders(id) on delete set null,
  name text not null,
  path text not null,
  content text not null,
  frontmatter_json jsonb,
  is_template boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(workspace_id, path)
);

alter table workspaces enable row level security;
alter table folders enable row level security;
alter table prompt_files enable row level security;

drop policy if exists "workspace owner" on workspaces;
create policy "workspace owner" on workspaces for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "folder by workspace owner" on folders;
create policy "folder by workspace owner" on folders for all using (
  exists(select 1 from workspaces w where w.id = folders.workspace_id and w.owner_id = auth.uid())
);

drop policy if exists "file by workspace owner" on prompt_files;
create policy "file by workspace owner" on prompt_files for all using (
  exists(select 1 from workspaces w where w.id = prompt_files.workspace_id and w.owner_id = auth.uid())
);

create unique index if not exists workspaces_owner_id_unique on workspaces(owner_id);

create or replace function public.initialize_starter_workspace()
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  starter_workspace_id uuid;
begin
  if current_user_id is null then
    raise exception 'initialize_starter_workspace requires an authenticated user';
  end if;

  insert into workspaces (owner_id, name)
  values (current_user_id, 'Workspace')
  on conflict (owner_id) do nothing;

  select id into starter_workspace_id
  from workspaces
  where owner_id = current_user_id
  limit 1;

  if starter_workspace_id is null then
    raise exception 'Failed to resolve workspace for user %', current_user_id;
  end if;

  return starter_workspace_id;
end;
$$;

grant execute on function public.initialize_starter_workspace() to authenticated;
`;

export function extractProjectRef(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname;
    if (!host.endsWith('.supabase.co')) return null;
    return host.split('.')[0] ?? null;
  } catch {
    return null;
  }
}

export async function installSchemaWithAccessToken(projectRef: string, accessToken: string) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: MIGRATION_SQL }),
  });

  if (!response.ok) {
    const text = await response.text();
    return { error: `${response.status} ${response.statusText}: ${text}` };
  }

  return { error: null as string | null };
}
