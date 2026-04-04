import type { AgentSettings } from './types';

const LOCAL_BASE_URL_DEFAULT = 'http://localhost:11434';

export function getSavedLocalRuntime(settings: AgentSettings): { baseUrl: string; model: string } {
  const baseUrl = settings.generation_params?.local_connection?.base_url?.trim() || LOCAL_BASE_URL_DEFAULT;
  const localModel = settings.generation_params?.local_connection?.model?.trim()
    || (settings.default_provider === 'ollama' ? settings.default_model.trim() : '');
  return { baseUrl, model: localModel };
}

