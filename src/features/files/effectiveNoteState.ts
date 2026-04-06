import { splitFrontmatter } from '../../lib/frontmatter';
import type { FrontmatterModel, ResearchNote } from '../../types/models';

export type DraftLike = {
  body: string;
  frontmatter: FrontmatterModel;
};

export type EffectiveNoteState = {
  body: string;
  frontmatter: FrontmatterModel;
};

const SYNCED_FRONTMATTER_KEYS: Array<keyof FrontmatterModel> = ['starred', 'template'];

export const resolveEffectiveNoteState = (
  file: ResearchNote,
  draftByFileId: Record<string, DraftLike | undefined>,
): EffectiveNoteState => {
  const draft = draftByFileId[file.id];
  if (draft) return { body: draft.body, frontmatter: draft.frontmatter };
  const parsed = splitFrontmatter(file.content);
  return { body: parsed.body, frontmatter: parsed.frontmatter };
};

export const reconcileDraftFrontmatterWithSaved = (
  draftFrontmatter: FrontmatterModel,
  savedFrontmatter: FrontmatterModel,
): FrontmatterModel => {
  let changed = false;
  const nextFrontmatter: FrontmatterModel = { ...draftFrontmatter };
  SYNCED_FRONTMATTER_KEYS.forEach((key) => {
    const savedValue = key === 'starred' ? savedFrontmatter.starred : savedFrontmatter.template;
    const draftValue = key === 'starred' ? nextFrontmatter.starred : nextFrontmatter.template;
    if (savedValue === undefined) {
      if (draftValue !== undefined) {
        if (key === 'starred') delete nextFrontmatter.starred;
        else delete nextFrontmatter.template;
        changed = true;
      }
      return;
    }
    if (draftValue !== savedValue) {
      if (key === 'starred') nextFrontmatter.starred = savedValue;
      else nextFrontmatter.template = savedValue;
      changed = true;
    }
  });
  return changed ? nextFrontmatter : draftFrontmatter;
};
