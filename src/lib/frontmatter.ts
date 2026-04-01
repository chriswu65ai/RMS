import YAML from 'yaml';
import type { FrontmatterModel } from '../types/models';

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

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

    const normalized = { ...(parsed as Record<string, unknown>) };
    delete normalized.templateType;

    if (typeof normalized.tags === 'string' && !Array.isArray(normalized.sectors)) {
      normalized.sectors = normalized.tags.split(',').map((tag) => tag.trim()).filter(Boolean);
    }
    delete normalized.tags;
    if (typeof normalized.sectors === 'string') {
      normalized.sectors = normalized.sectors.split(',').map((item) => item.trim()).filter(Boolean);
    }

    if (typeof normalized.ticker === 'string') {
      normalized.ticker = normalized.ticker.trim().toUpperCase();
    }

    const recommendation = typeof normalized.recommendation === 'string' ? normalized.recommendation.trim().toLowerCase() : '';
    const stockRecommendation = typeof normalized.stock_recommendation === 'string' ? normalized.stock_recommendation.trim().toLowerCase() : '';
    const normalizedRecommendation = recommendation || stockRecommendation || '';
    normalized.recommendation = normalizedRecommendation;
    normalized.stock_recommendation = normalizedRecommendation;

    return { frontmatter: normalized as FrontmatterModel, body };
  } catch {
    return { frontmatter: {}, body: markdown };
  }
}

export function composeMarkdown(frontmatter: FrontmatterModel, body: string): string {
  const cleaned = Object.fromEntries(
    Object.entries(frontmatter).filter(([, v]) => v !== '' && v !== undefined && v !== null),
  ) as Record<string, unknown>;
  if (Object.keys(cleaned).length === 0) return body;

  const sectors = Array.isArray(cleaned.sectors) ? cleaned.sectors : undefined;
  if (sectors) {
    delete cleaned.sectors;
  }

  const yamlSections: string[] = [];
  if (Object.keys(cleaned).length > 0) {
    yamlSections.push(YAML.stringify(cleaned).trimEnd());
  }
  if (sectors && sectors.length > 0) {
    const inlineSectors = sectors.join(', ');
    yamlSections.push(`sectors: ${inlineSectors}`);
  }

  const yaml = yamlSections.join('\n');
  return `---\n${yaml}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}
