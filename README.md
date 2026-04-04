# Stock Research Management System

Stock Research Management System is a Markdown-first app for managing stock research notes with a local SQLite backend and optional agent-assisted generation.

## Feature overview

- Local-first runtime with SQLite-backed API routes (`/api/bootstrap`, `/api/files`, `/api/folders`, and `/api/agent/*`).
- Folder/file manager for stock research notes with template-driven note creation.
- Metadata workflow for equity research (`ticker`, `type`, `date`, `sector`, recommendation).
- Agent settings for provider/model defaults, local Ollama runtime, and web search-assisted generation.
- Preferred source list for domain weighting/filtering during web search.
- Activity log for agent calls and outcomes (success, failures, cancellation).
- Markdown editing, preview, and import/export with folder structure parity.

## Agent web search configuration fields

The web search settings saved in `generation_params.web_search` are:

- `enabled` (`boolean`): turn enrichment on/off.
- `provider` (`duckduckgo | searxng`): active search backend.
- `provider_config.searxng.base_url` (`string`): SearXNG origin used for `/search` requests (default: `http://localhost:8080`).
- `provider_config.searxng.use_json_api` (`boolean`): request SearXNG JSON mode (`format=json`) instead of HTML parsing.
- `mode` (`single | deep`):
  - `single`: one query using the prompt text.
  - `deep`: up to three related queries (`base`, `latest updates`, `official source`).
- `max_results` (`number >= 1`): fetch cap before dedupe/final cap logic.
- `timeout_ms` (`number >= 1`): total search timeout budget.
- `safe_search` (`boolean`): stored UI preference for provider-level filtering.
- `recency` (`any | 7d | 30d | 365d`): stored UI preference for time filtering.
- `domain_policy` (`open_web | prefer_list | only_list`):
  - `open_web`: no preferred-source policy applied.
  - `prefer_list`: open web + preferred-source ranking boosts.
  - `only_list`: strict domain filtering to enabled preferred sources.

### Agent > Web Search: SearXNG setup notes

- If you select **SearXNG** in the provider dropdown, the Agent page shows:
  - **SearXNG base URL** (text input)
  - **Use JSON API** (checkbox)
- LAN/Docker caveat: if SearXNG runs on a different machine, do **not** use `localhost` from the app container. Use the host's reachable LAN IP instead, for example `http://10.11.10.11:2000`.
- Authentication support for SearXNG is intentionally deferred to phase 2 to keep the first rollout simple.

## Privacy and logging

- Runtime data is local. SQLite data is persisted in `/data/researchmanager.db` (compose volume).
- Search diagnostics are appended to `data/search-runtime.log` for operational debugging.
- The app **does not** emit raw SQL query logs for normal DB operations.
- API keys are stored via the local secret store and are not written to the search runtime log.

## Operational troubleshooting

- **No search sources returned**
  - Confirm web search is enabled in Agent settings.
  - Check whether `domain_policy=only_list` is over-restrictive for current preferred sources.
  - Inspect `data/search-runtime.log` for provider errors/timeouts.
- **Search warning events in the stream**
  - Generation is fail-open: text generation can continue while search fails.
  - Validate network egress and retry with lower `max_results` or higher `timeout_ms`.
- **Ollama connection issues**
  - Verify local base URL (default: `http://localhost:11434`) and local model availability.
  - Use “Refresh models” after runtime/model changes.
- **Model mismatch between default model and local runtime model**
  - Save defaults again; for Ollama, the selected model is mirrored into runtime model state.

## Setup (Docker only)

1. Build and start:
   ```bash
   docker compose up --build
   ```
2. Open `http://localhost:4173`.
