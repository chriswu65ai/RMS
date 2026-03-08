import matter from 'gray-matter';
import YAML from 'yaml';
import type { FrontmatterModel } from '../types/models';

export function splitFrontmatter(markdown: string): { frontmatter: FrontmatterModel; body: string } {
  const parsed = matter(markdown);
  return { frontmatter: parsed.data as FrontmatterModel, body: parsed.content };
}

export function composeMarkdown(frontmatter: FrontmatterModel, body: string): string {
  const cleaned = Object.fromEntries(
    Object.entries(frontmatter).filter(([, v]) => v !== '' && v !== undefined && v !== null),
  );
  if (Object.keys(cleaned).length === 0) return body;
  const yaml = YAML.stringify(cleaned).trimEnd();
  return `---\n${yaml}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}
