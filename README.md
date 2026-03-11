# Prompt Manager (MVP)

Prompt Manager is a Markdown-first, sync-friendly web app for organizing, editing, searching, and reusing prompt files with templates.

## Architecture overview

- **Frontend:** React + TypeScript + Vite
- **Styling/UI:** Tailwind CSS with responsive app shell
- **Routing:** BrowserRouter (single route for MVP)
- **Editor:** CodeMirror (`@uiw/react-codemirror`) with markdown extension
- **Preview:** `react-markdown`
- **Frontmatter parsing/composing:** browser-safe YAML frontmatter parser + `yaml`
- **State:** Zustand (`usePromptStore`) for workspace/folder/file global state
- **Backend:** Supabase (Auth + Postgres)
- **Data model:** markdown content + folder/file metadata in database, preserving portability and future export capability

## Data model

Implemented schema:
- `workspaces`
- `folders`
- `prompt_files`

`prompt_files.content` stores the canonical Markdown including frontmatter for MVP simplicity.

## Setup

### Quick Setup (Supabase CLI default path)

1. Install the Supabase CLI and Docker Desktop.
2. Copy env file:

```bash
cp .env.example .env.local
```

3. Create a Supabase project, then link your repo:

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

4. Build the schema installer artifact from migrations (single source-of-truth):

```bash
npm run build:schema-installer
```

5. Apply schema and functions from migrations:

```bash
supabase db push --include-all
```

6. (Optional) initialize an empty workspace via CLI seed command:

```bash
supabase db seed
```

7. Fill in `.env.local` with Supabase project values.
8. Install dependencies and run:

```bash
npm install
npm run dev
```

9. Open `http://localhost:5173`.

### Supabase CLI workflow files

- `.github/workflows/supabase-db-push.yml`: links the project and runs `supabase db push --include-all` on `main` changes under `supabase/`.
- `.github/workflows/supabase-migrations-validate.yml`: checks that `supabase/installer/schema.sql` matches `supabase/migrations/*.sql`, then starts a local Supabase stack and runs `supabase db reset --local` to validate migrations end-to-end.

`supabase/migrations/*.sql` remains the only schema source-of-truth. `supabase/installer/schema.sql` is a generated deployment artifact used by backend provisioning and should be regenerated via `npm run build:schema-installer` whenever migrations change.

### Manual dashboard setup (advanced / troubleshooting)

Use this only if CLI access is blocked.

1. Create a Supabase project.
2. In SQL editor run migrations in order from `supabase/migrations/` (single source-of-truth).
3. Rebuild installer artifact for backend provisioning flows:
   - `npm run build:schema-installer`
4. Enable email auth (magic link).
5. Optionally run `supabase/seed/seed.sql`.


## Workspace initialization idempotency

`public.initialize_starter_workspace()` is safe to rerun:
- It creates at most one workspace per user (`workspaces.owner_id` unique index + `on conflict do nothing`).
- It does not insert any starter folders or files, so new accounts begin with a blank database.

The client calls this RPC only when no workspace exists in `usePromptStore.bootstrap`, so first-run accounts are initialized once automatically.

If a brand-new Supabase project is connected before migrations are applied, the app now detects the missing schema and surfaces a guided error that points to `supabase db push --include-all` instead of failing with a raw schema-cache table error.

## Deploy (Vercel)

1. Push repository to GitHub.
2. Import into Vercel.
3. Set env vars:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy with default Vite settings.

## Core implemented flows

- Magic-link sign-in via Supabase Auth
- Workspace initialization via `initialize_starter_workspace()` on first run (empty workspace only)
- Folder tree with create/delete (with non-empty guard)
- File list with create/delete
- Global search by filename and content
- Markdown editing + preview + split mode
- Unsaved changes indicator and save action
- Copy prompt action
- Frontmatter metadata editor (title/tags/template flags + add/delete template type actions)
- Create new file from **file template**
- Loading + error + empty states
- Duplicate name checks for new files/folders
- Destructive confirmation dialogs
- Responsive shell with mobile sidebar drawer + template modal bottom-sheet behavior
- One-click export of all prompts as a ZIP of `.md` files (folder structure preserved)

## Tradeoffs

- **Single-page MVP routing:** React Router ready but minimal route complexity for speed.
- **Database content storage:** markdown in Postgres instead of object storage for simpler sync and search in MVP.
- **Snippet insertion location:** currently appends snippet at end of document (cursor insertion can be added by exposing CodeMirror view state in phase 2).
- **Rename/move/duplicate action UI:** data model supports it; full action surface can be extended quickly by adding path recalculation helpers.

## Future extension ideas

- Cursor-level snippet insertion.
- Full rename/move/duplicate workflows for files/folders.
- Multi-workspace selector.
- Full-text search index (`tsvector`) + tag filter chips.
- Export/import folder trees as `.md` files.

## First-run runtime config fallback

If the app starts without valid `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY`, it now shows a first-run setup wizard.

- **Hosted deployments (recommended):** set these values in your hosting provider so app config is server-managed and users never need to paste credentials in-browser.
- **Local/self-hosted development:** create `/workspace/promptmanager/.env.local` (project root) and provide both values there, or use the wizard which stores values in browser `localStorage` on that device.
- **No CLI setup path:** Step 4 calls a backend endpoint (`/api/setup/supabase`) that performs Supabase provisioning + schema installation server-side by executing `supabase/installer/schema.sql` (generated from `supabase/migrations`). Set `SUPABASE_MANAGEMENT_PAT` on the backend; PAT is never returned to the browser.
- **Dev-only PAT override:** optional and disabled by default. Enable `VITE_ENABLE_DEV_PAT_SETUP=true` (frontend) and `SUPABASE_ALLOW_DEV_PAT=true` (backend) to temporarily allow entering a short-lived PAT in local development only.
