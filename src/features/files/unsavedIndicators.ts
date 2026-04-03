import YAML from 'yaml';
import type { DraftEntry } from '../../hooks/useResearchStore';
import type { ResearchNote } from '../../types/models';

const composeDraftMarkdown = (draft: DraftEntry) => {
  const cleanedRaw = Object.fromEntries(
    Object.entries(draft.frontmatter).filter(([, value]) => value !== '' && value !== undefined && value !== null),
  ) as Record<string, unknown>;

  if (Object.keys(cleanedRaw).length === 0) return draft.body;

  const orderedKeys = ['date', 'title', 'ticker', 'sector', 'recommendation', 'type', 'template', 'starred'];
  const consumedKeys = new Set<string>();
  const lines: string[] = [];

  orderedKeys.forEach((key) => {
    if (!(key in cleanedRaw)) return;
    consumedKeys.add(key);
    lines.push(YAML.stringify({ [key]: cleanedRaw[key] }).trimEnd());
  });

  Object.entries(cleanedRaw).forEach(([key, value]) => {
    if (consumedKeys.has(key)) return;
    lines.push(YAML.stringify({ [key]: value }).trimEnd());
  });

  return `---\n${lines.join('\n')}\n---\n${draft.body.startsWith('\n') ? draft.body.slice(1) : draft.body}`;
};

export const deriveUnsavedFileIds = (files: ResearchNote[], draftByFileId: Record<string, DraftEntry>) => {
  const fileById = new Map(files.map((file) => [file.id, file] as const));

  return Object.entries(draftByFileId)
    .filter(([fileId, draft]) => {
      const file = fileById.get(fileId);
      if (!file || !draft) return false;
      return composeDraftMarkdown(draft) !== file.content;
    })
    .map(([fileId]) => fileId);
};

export const getFileTitleIndicators = ({ isStarred, isUnsaved }: { isStarred: boolean; isUnsaved: boolean }) => {
  if (isStarred) return isUnsaved ? ['starred', 'unsaved'] as const : ['starred'] as const;
  return isUnsaved ? ['unsaved'] as const : [] as const;
};
