# Stock Research Management System

Stock Research Management System is a Markdown-first app for managing stock research notes with a local SQLite backend.

## Part 1 Scope (Current Baseline)

- Local-first runtime using SQLite and local API routes (`/api/bootstrap`, `/api/files`, `/api/folders`).
- Folder + file manager for stock research notes.
- Metadata workflow with stock fields (`ticker`, `type`, `date`, `sectors`) and recommendation enum (`buy`, `hold`, `sell`, `avoid`, or blank).
- Template-based note creation and canonical filename pattern:
  - `YYYY-MM-DD <TICKER>-<TYPE>.md`
- Markdown editor + preview panes.
- Import/export support with folder structure parity.

## Setup (Docker only)

1. Build and start:
   ```bash
   docker compose up --build
   ```
2. Open:
   - `http://localhost:4173`

SQLite data is persisted to `/data/researchmanager.db` in the compose volume.
