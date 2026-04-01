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
