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

create type template_type as enum ('file', 'snippet');

create table if not exists prompt_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  folder_id uuid references folders(id) on delete set null,
  name text not null,
  path text not null,
  content text not null,
  frontmatter_json jsonb,
  is_template boolean default false,
  template_type template_type,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(workspace_id, path)
);

alter table workspaces enable row level security;
alter table folders enable row level security;
alter table prompt_files enable row level security;

create policy "workspace owner" on workspaces for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "folder by workspace owner" on folders for all using (
  exists(select 1 from workspaces w where w.id = folders.workspace_id and w.owner_id = auth.uid())
);
create policy "file by workspace owner" on prompt_files for all using (
  exists(select 1 from workspaces w where w.id = prompt_files.workspace_id and w.owner_id = auth.uid())
);
