import YAML from 'yaml';
import { Recommendation, type FrontmatterModel, type Note, type ResearchNote } from '../types/models';

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const CANONICAL_FRONTMATTER_KEYS = new Set([
  'title',
  'ticker',
  'type',
  'date',
  'sector',
  'recommendation',
  'assignee',
  'template',
  'starred',
]);

const VALID_RECOMMENDATIONS = new Set<Recommendation>(Object.values(Recommendation));

type FrontmatterNormalizeOptions = {
  knownSectors?: string[];
  knownNoteTypes?: string[];
};

const normalizeKey = (key: string) => {
  const trimmed = key.trim();
  const lowered = trimmed.toLowerCase();
  return CANONICAL_FRONTMATTER_KEYS.has(lowered) ? lowered : trimmed;
};

const normalizeSectorValue = (value: string, knownSectors?: string[]) => {
  const trimmed = value.trim();
  if (!trimmed || !knownSectors || knownSectors.length === 0) return trimmed;
  const match = knownSectors.find((sector) => sector.trim().toLowerCase() === trimmed.toLowerCase());
  return match?.trim() ?? trimmed;
};

const normalizeNoteTypeValue = (value: string, knownNoteTypes?: string[]) => {
  const trimmed = value.trim();
  if (!trimmed || !knownNoteTypes || knownNoteTypes.length === 0) return trimmed;
  const match = knownNoteTypes.find((type) => type.trim().toLowerCase() === trimmed.toLowerCase());
  return match?.trim() ?? trimmed;
};

export function normalizeRecommendation(value: unknown): Recommendation | '' {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase() as Recommendation;
  return VALID_RECOMMENDATIONS.has(normalized) ? normalized : '';
}

export function normalizeFrontmatter(input: Record<string, unknown> | null | undefined, options?: FrontmatterNormalizeOptions): FrontmatterModel {
  if (!input) return {};
  const normalized = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [normalizeKey(key), value]),
  ) as Record<string, unknown>;

  Object.entries(normalized).forEach(([key, value]) => {
    if (typeof value === 'string') {
      normalized[key] = value.trim();
    }
  });

  delete normalized.templateType;
  if (typeof normalized.sector === 'string') {
    normalized.sector = normalizeSectorValue(normalized.sector, options?.knownSectors);
  }

  if (typeof normalized.ticker === 'string') {
    normalized.ticker = normalized.ticker.trim().toUpperCase();
  }

  if (typeof normalized.template === 'string') {
    const value = normalized.template.trim().toLowerCase();
    if (value === 'true') normalized.template = true;
    if (value === 'false') normalized.template = false;
  }

  if (typeof normalized.starred === 'string') {
    const value = normalized.starred.trim().toLowerCase();
    if (value === 'true') normalized.starred = true;
    if (value === 'false') normalized.starred = false;
  }

  normalized.recommendation = normalizeRecommendation(normalized.recommendation);

  if (typeof normalized.title === 'string') normalized.title = normalized.title.trim();
  if (typeof normalized.type === 'string') normalized.type = normalizeNoteTypeValue(normalized.type, options?.knownNoteTypes);
  if (typeof normalized.date === 'string') normalized.date = normalized.date.trim();
  if (typeof normalized.assignee === 'string') normalized.assignee = normalized.assignee.trim();

  return normalized as FrontmatterModel;
}

export function splitFrontmatter(markdown: string, options?: FrontmatterNormalizeOptions): { frontmatter: FrontmatterModel; body: string } {
  const match = markdown.match(FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: {}, body: markdown };
  }

  const [, rawYaml] = match;
  const body = markdown.slice(match[0].length);
  const normalizedYaml = rawYaml.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  try {
    const parsed = YAML.parse(normalizedYaml);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { frontmatter: {}, body };
    }

    return { frontmatter: normalizeFrontmatter(parsed as Record<string, unknown>, options), body };
  } catch {
    return { frontmatter: {}, body: markdown };
  }
}

export function composeMarkdown(frontmatter: FrontmatterModel, body: string): string {
  const normalized = normalizeFrontmatter(frontmatter as Record<string, unknown>);
  const cleanedRaw = Object.fromEntries(
    Object.entries(normalized).filter(([, v]) => v !== '' && v !== undefined && v !== null),
  ) as Record<string, unknown>;
  if (Object.keys(cleanedRaw).length === 0) return body;

  const orderedKeys = ['date', 'title', 'ticker', 'sector', 'recommendation', 'type', 'template', 'starred'];
  const consumedKeys = new Set<string>();
  const lines: string[] = [];

  orderedKeys.forEach((key) => {
    if (!(key in cleanedRaw)) return;
    consumedKeys.add(key);
    if (key === 'sector') {
      const sector = typeof cleanedRaw.sector === 'string' ? cleanedRaw.sector.trim() : '';
      if (sector) lines.push(`sector: ${sector}`);
      return;
    }
    lines.push(YAML.stringify({ [key]: cleanedRaw[key] }).trimEnd());
  });

  Object.entries(cleanedRaw).forEach(([key, value]) => {
    if (consumedKeys.has(key)) return;
    lines.push(YAML.stringify({ [key]: value }).trimEnd());
  });

  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

export function fileToNoteModel(file: ResearchNote): Note {
  const { frontmatter } = splitFrontmatter(file.content);
  const fallbackTitle = typeof frontmatter.title === 'string' && frontmatter.title.trim().length > 0
    ? frontmatter.title.trim()
    : file.name.replace(/\.md$/i, '');
  return {
    id: file.id,
    title: fallbackTitle,
    type: frontmatter.type || '—',
    date: frontmatter.date || '',
    assignee: frontmatter.assignee || '—',
    stock: {
      ticker: frontmatter.ticker || '—',
      sectors: frontmatter.sector ? [frontmatter.sector] : [],
      recommendation: frontmatter.recommendation ?? '',
    },
    path: file.path,
    createdAt: file.created_at,
    updatedAt: file.updated_at,
  };
}
