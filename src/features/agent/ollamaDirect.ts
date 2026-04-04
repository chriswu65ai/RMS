import type { ModelListItem } from './types';

type OllamaTagsResponse = {
  models?: Array<{ name?: string }>;
};

const normalizeBaseUrl = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, '');

export async function fetchOllamaTagsDirect(baseUrl: string): Promise<ModelListItem[]> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${normalizedBaseUrl}/api/tags`);
  if (!response.ok) throw new Error('Could not fetch local Ollama tags.');
  const payload = await response.json() as OllamaTagsResponse;
  const models = Array.isArray(payload.models)
    ? payload.models
      .map((entry) => entry?.name?.trim() || '')
      .filter((entry) => entry.length > 0)
    : [];
  return models.map((modelId) => ({ modelId, displayName: modelId }));
}

