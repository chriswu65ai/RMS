-- Replace USER_ID with an auth user id before running.
-- Use fixed UUIDs for predictable local seed references.
insert into workspaces (id, owner_id, name)
values ('00000000-0000-0000-0000-000000000001', 'USER_ID', 'Workspace')
on conflict do nothing;

insert into folders (id, workspace_id, parent_id, name, path)
values
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', null, 'Research', 'Research'),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', null, 'Templates', 'Templates')
on conflict do nothing;

insert into prompt_files (workspace_id, folder_id, name, path, content, frontmatter_json, is_template)
values
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','weekly-research.md','Research/weekly-research.md','---
title: Weekly Research
tags: [research, finance]
---
# Weekly Research Prompt
Summarize the key market themes for this week.','{"title":"Weekly Research","tags":["research","finance"]}',false),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','research-template.md','Templates/research-template.md','---
title: Weekly Research
template: true
tags: [research]
---
# Weekly Research
## Context
## Questions
## Deliverable','{"title":"Weekly Research","template":true,"tags":["research"]}',true),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','constraint-snippet.md','Templates/constraint-snippet.md','---
title: Tone and Constraints
template: true
---
## Constraints
- Keep answer under 200 words
- Cite all assumptions','{"title":"Tone and Constraints","template":true}',true);
