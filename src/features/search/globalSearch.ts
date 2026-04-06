import type { ResearchNote } from '../../types/models';

export type SearchIndexEntry = {
  file: ResearchNote;
  tickerLower: string;
  titleLower: string;
  fileNameLower: string;
  contentLower: string;
};

export const buildGlobalSearchIndex = (files: ResearchNote[]): SearchIndexEntry[] => files
  .filter((file) => !file.is_template)
  .map((file) => {
    const tickerMatch = file.content.match(/(?:^|\n)ticker:\s*(.+)\s*(?:\n|$)/i);
    const titleMatch = file.content.match(/(?:^|\n)title:\s*(.+)\s*(?:\n|$)/i);
    return {
      file,
      tickerLower: tickerMatch?.[1]?.trim().toLowerCase() ?? '',
      titleLower: titleMatch?.[1]?.trim().toLowerCase() ?? '',
      fileNameLower: file.name.toLowerCase(),
      contentLower: file.content.toLowerCase(),
    };
  });

export const queryGlobalSearchIndex = (index: SearchIndexEntry[], search: string, limit = 8) => {
  const q = search.trim().toLowerCase();
  if (!q) return [];

  return index
    .map((entry) => {
      let score = 0;
      if (entry.tickerLower === q) score += 150;
      else if (entry.tickerLower.includes(q)) score += 90;
      if (entry.titleLower === q) score += 120;
      else if (entry.titleLower.includes(q)) score += 80;
      if (entry.fileNameLower.includes(q)) score += 30;
      if (entry.contentLower.includes(q)) score += 10;
      return { file: entry.file, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.file);
};
