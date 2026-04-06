export const DEFAULT_NOTE_TYPES = ['Research', 'Event', 'Earnings', 'Deepdive', 'Summary'] as const;

const normalizeTypeList = (items: unknown[]): string[] => {
  const normalized: string[] = [];
  const seen = new Set<string>();
  items.forEach((item) => {
    if (typeof item !== 'string') return;
    const value = item.trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push(value);
  });
  return normalized;
};

export const resolveAllowedNoteTypes = (input?: {
  settingsNoteTypes?: unknown;
  discoveredTaskNoteTypes?: string[];
}): string[] => {
  const fromSettings = Array.isArray(input?.settingsNoteTypes)
    ? normalizeTypeList(input?.settingsNoteTypes as unknown[])
    : [];
  const discovered = normalizeTypeList(input?.discoveredTaskNoteTypes ?? []);
  const fallback = [...DEFAULT_NOTE_TYPES];
  return normalizeTypeList([...fromSettings, ...discovered, ...fallback]);
};

export const resolveCanonicalNoteType = (value: unknown, allowedNoteTypes: string[]): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const match = allowedNoteTypes.find((allowed) => allowed.toLowerCase() === normalized.toLowerCase());
  return match ?? null;
};

export const formatNoteTypeSuggestions = (allowedNoteTypes: string[]): string => allowedNoteTypes.join(', ');

export const resolveTemplateForNoteType = <T extends { path: string; content: string; frontmatter_json: Record<string, unknown> | null; is_template: number | boolean }>(
  templates: T[],
  canonicalNoteType: string,
): T | null => {
  const target = canonicalNoteType.trim().toLowerCase();
  if (!target) return null;
  const matching = templates
    .filter((template) => Boolean(template.is_template) || template.path.toLowerCase().includes('templates/'))
    .filter((template) => {
      const type = typeof template.frontmatter_json?.type === 'string' ? template.frontmatter_json.type.trim().toLowerCase() : '';
      return type === target;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return matching[0] ?? null;
};

export const stripSimpleFrontmatter = (content: string): string => {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---\n')) return content.trim();
  const end = trimmed.indexOf('\n---\n', 4);
  if (end < 0) return content.trim();
  return trimmed.slice(end + '\n---\n'.length).trim();
};
