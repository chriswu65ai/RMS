import YAML from 'yaml';
import type { FrontmatterModel, Note, PromptFile, Recommendation } from '../types/models';

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

const VALID_RECOMMENDATIONS = new Set<Recommendation>(['buy', 'hold', 'sell', 'avoid']);

export function normalizeRecommendation(value: unknown): Recommendation | '' {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase() as Recommendation;
  return VALID_RECOMMENDATIONS.has(normalized) ? normalized : '';
}

export function normalizeFrontmatter(input: Record<string, unknown> | null | undefined): FrontmatterModel {
  if (!input) return {};
  const normalized = { ...input } as Record<string, unknown>;
  delete normalized.templateType;

  if (typeof normalized.tags === 'string' && !Array.isArray(normalized.sectors)) {
    normalized.sectors = normalized.tags.split(',').map((tag) => tag.trim()).filter(Boolean);
  }
  delete normalized.tags;

  if (typeof normalized.sectors === 'string') {
    normalized.sectors = normalized.sectors.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(normalized.sectors)) {
    normalized.sectors = normalized.sectors.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof normalized.ticker === 'string') {
    normalized.ticker = normalized.ticker.trim().toUpperCase();
  }

  const recommendation = normalizeRecommendation(normalized.recommendation);
  const stockRecommendation = normalizeRecommendation(normalized.stock_recommendation);
  const finalRecommendation = recommendation || stockRecommendation;
  normalized.recommendation = finalRecommendation;
  normalized.stock_recommendation = finalRecommendation;

  if (typeof normalized.title === 'string') normalized.title = normalized.title.trim();
  if (typeof normalized.type === 'string') normalized.type = normalized.type.trim();
  if (typeof normalized.date === 'string') normalized.date = normalized.date.trim();
  if (typeof normalized.assignee === 'string') normalized.assignee = normalized.assignee.trim();

  return normalized as FrontmatterModel;
}

export function splitFrontmatter(markdown: string): { frontmatter: FrontmatterModel; body: string } {
  const match = markdown.match(FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: {}, body: markdown };
  }

  const [, rawYaml] = match;
  const body = markdown.slice(match[0].length);

  try {
    const parsed = YAML.parse(rawYaml);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { frontmatter: {}, body };
    }

    return { frontmatter: normalizeFrontmatter(parsed as Record<string, unknown>), body };
  } catch {
    return { frontmatter: {}, body: markdown };
  }
}

export function composeMarkdown(frontmatter: FrontmatterModel, body: string): string {
  const normalized = normalizeFrontmatter(frontmatter as Record<string, unknown>);
  const cleaned = Object.fromEntries(
    Object.entries(normalized).filter(([, v]) => v !== '' && v !== undefined && v !== null),
  ) as Record<string, unknown>;
  if (Object.keys(cleaned).length === 0) return body;

  const sectors = Array.isArray(cleaned.sectors) ? cleaned.sectors : undefined;
  if (sectors) delete cleaned.sectors;

  const yamlSections: string[] = [];
  if (Object.keys(cleaned).length > 0) yamlSections.push(YAML.stringify(cleaned).trimEnd());
  if (sectors && sectors.length > 0) yamlSections.push(`sectors: ${sectors.join(', ')}`);

  return `---\n${yamlSections.join('\n')}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

export function fileToNoteModel(file: PromptFile): Note {
  const { frontmatter } = splitFrontmatter(file.content);
  return {
    id: file.id,
    title: frontmatter.title || file.name,
    type: frontmatter.type || '—',
    date: frontmatter.date || '',
    assignee: frontmatter.assignee || '—',
    stock: {
      ticker: frontmatter.ticker || '—',
      sectors: frontmatter.sectors ?? [],
      recommendation: frontmatter.recommendation ?? '',
    },
    path: file.path,
    updatedAt: file.updated_at,
  };
}
