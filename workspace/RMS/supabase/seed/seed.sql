-- Workspace bootstrap for the currently authenticated user.
--
-- Idempotent behavior:
-- - Reuses the first workspace for auth.uid() if one already exists.
-- - Creates an empty workspace only when absent by owner_id.
-- - Safe to rerun; existing records are not duplicated.
select public.initialize_starter_workspace();
