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

    return { frontmatter: normalized as FrontmatterModel, body };
  } catch {
    return { frontmatter: {}, body: markdown };
  }
}

export function composeMarkdown(frontmatter: FrontmatterModel, body: string): string {
  const cleaned = Object.fromEntries(
    Object.entries(frontmatter).filter(([, v]) => v !== '' && v !== undefined && v !== null),
  );
  if (Object.keys(cleaned).length === 0) return body;
  const yaml = YAML.stringify(cleaned).trimEnd();
  return `---\n${yaml}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}
