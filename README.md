# Prompt Manager

Prompt Manager is a Markdown-first web app for organizing prompts with folders, templates, and a split markdown editor.

## What changed

This project now runs fully local with **SQLite** and does **not** require Supabase or any setup wizard.

- Local API routes are served by the Vite server (`/api/*`).
- Data is persisted in a SQLite DB file (`data/promptmanager.db` by default).
- On first run, the app auto-creates a workspace plus starter folders/files.

## Run locally

```bash
npm run dev
```

Then open `http://localhost:5173`.

## Run with Docker

```bash
docker compose up --build
```

Then open `http://localhost:4173`.

### Persistence

The compose file mounts a named volume at `/data`, and the app stores SQLite at:

- `/data/promptmanager.db`

You can override this path with:

- `SQLITE_PATH`

## Stack

- React + TypeScript + Vite
- Zustand for app state
- Tailwind CSS
- SQLite (local file)
