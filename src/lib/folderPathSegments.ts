export const normalizeFolderPathSegments = (path: string): string[] => path
  .split('/')
  .map((part) => part.trim())
  .filter(Boolean);
