-- Replace USER_ID with an auth user id before running.
insert into workspaces (id, owner_id, name)
values ('11111111-1111-1111-1111-111111111111', 'USER_ID', 'Demo Workspace')
on conflict do nothing;

insert into folders (id, workspace_id, parent_id, name, path)
values
  ('22222222-2222-2222-2222-222222222221', '11111111-1111-1111-1111-111111111111', null, 'Research', 'Research'),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', null, 'Templates', 'Templates')
on conflict do nothing;

insert into prompt_files (workspace_id, folder_id, name, path, content, frontmatter_json, is_template, template_type)
values
('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222221','weekly-research.md','Research/weekly-research.md','---
title: Weekly Research
tags: [research, finance]
---
# Weekly Research Prompt
Summarize the key market themes for this week.','{"title":"Weekly Research","tags":["research","finance"]}',false,null),
('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','research-template.md','Templates/research-template.md','---
title: Weekly Research
template: true
templateType: file
tags: [research]
---
# Weekly Research
## Context
## Questions
## Deliverable','{"title":"Weekly Research","template":true,"templateType":"file","tags":["research"]}',true,'file'),
('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','constraint-snippet.md','Templates/constraint-snippet.md','---
title: Tone and Constraints
template: true
templateType: snippet
---
## Constraints
- Keep answer under 200 words
- Cite all assumptions','{"title":"Tone and Constraints","template":true,"templateType":"snippet"}',true,'snippet');
