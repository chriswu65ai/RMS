# Integration QA Checklist (Part 2/3 Hardening)

## Static verification
- [ ] `npm run lint` passes.
- [ ] `npm run build` passes.
- [ ] Targeted mapper + critical state transition checks are executed locally.

## Local app behavior checks
- [ ] Overview filters/sort/search remain deterministic and row click opens Stock Research context.
- [ ] New Research kanban drag/drop updates status and sets/clears completion date correctly.
- [ ] Archive/unarchive toggles visibility with "Show archived" behavior.
- [ ] Task → note bridge handles existing note, new note creation, and missing/deleted linked note fallback.
- [ ] Search result click preserves deterministic context transition to Stock Research.
- [ ] App restores last view + selected ticker context after reload.

## Part 1 regression checks
- [ ] Import/export still works for markdown + zip workflows.
- [ ] Editor pane metadata + rename-on-identity-blur still functional.
- [ ] Templates and file list behavior unchanged in Stock Research route.
- [ ] Renaming/moving a file from File List updates `linked_note_path` on linked New Research task cards after refresh.
- [ ] Metadata panel behavior is responsive: `<lg` shows a visible Metadata toggle, opening it exposes the Sector selector, and `>=lg` still supports collapse/expand without losing access to Sector.
