import type { SettingsList } from '../types/models';

export const normalizeList = (items: string[]) => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  items.map((item) => item.trim()).filter(Boolean).forEach((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push(item);
  });
  return normalized;
};

export const normalizeListWithFallback = (items: string[], fallback: string[]) => {
  const normalized = normalizeList(items);
  return normalized.length > 0 ? normalized : fallback;
};

export const mergeMetadataListsWithDefaults = (items: Partial<SettingsList> | undefined, fallback: SettingsList): SettingsList => ({
  noteTypes: normalizeListWithFallback(items?.noteTypes ?? fallback.noteTypes, fallback.noteTypes),
  assignees: normalizeListWithFallback(items?.assignees ?? fallback.assignees, fallback.assignees),
  sectors: normalizeListWithFallback(items?.sectors ?? fallback.sectors, fallback.sectors),
});
