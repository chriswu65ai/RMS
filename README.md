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
- enum `template_type` (`file`, `snippet`)

`prompt_files.content` stores the canonical Markdown including frontmatter for MVP simplicity.

## Setup

1. Copy env file:

```bash
cp .env.example .env.local
```

2. Fill in Supabase values.

3. Install dependencies and run:

```bash
npm install
npm run dev
```

4. Open `http://localhost:5173`.

## Supabase setup

1. Create a Supabase project.
2. In SQL editor run migration:
   - `supabase/migrations/202603080001_init.sql`
3. Enable email auth (magic link).
4. (Optional) seed demo data:
   - Replace `USER_ID` in `supabase/seed/seed.sql`
   - Run the seed SQL.

## Deploy (Vercel)

1. Push repository to GitHub.
2. Import into Vercel.
3. Set env vars:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy with default Vite settings.

## Core implemented flows

- Magic-link sign-in via Supabase Auth
- Workspace bootstrap (auto-create first workspace)
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
