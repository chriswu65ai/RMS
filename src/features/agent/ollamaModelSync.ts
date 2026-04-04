import type { AgentProvider } from './types';
import type { getAgentSettings } from '../../lib/agentApi';

const LOCAL_BASE_URL_DEFAULT = 'http://localhost:11434';

export const getMirroredOllamaDraftModel = (currentProvider: AgentProvider, nextModel: string, currentDraft: string) => (
  currentProvider === 'ollama' ? nextModel : currentDraft
);

export const buildSaveDefaultsPayload = (
  settings: Awaited<ReturnType<typeof getAgentSettings>>,
  currentProvider: AgentProvider,
  selectedModel: string,
  baseUrlInput: string,
) => {
  const canonicalBaseUrl = baseUrlInput.trim() || LOCAL_BASE_URL_DEFAULT;
  const canonicalModel = selectedModel.trim();
  return {
    ...settings,
    default_provider: currentProvider,
    default_model: canonicalModel,
    ...(currentProvider === 'ollama'
      ? {
          generation_params: {
            ...(settings.generation_params ?? {}),
            local_connection: {
              base_url: canonicalBaseUrl,
              model: canonicalModel,
              B: settings.generation_params?.local_connection?.B ?? 1,
            },
          },
        }
      : {}),
  };
};
