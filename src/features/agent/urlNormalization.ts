export const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

export const normalizeEndpointUrl = (value: string, fallback: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return stripTrailingSlashes(trimmed) || fallback;
};
