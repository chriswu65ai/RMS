import type { AgentProvider } from './types';
import type { getAgentSettings } from '../../lib/agentApi';

const LOCAL_BASE_URL_DEFAULT = 'http://localhost:11434';

export const getMirroredOllamaDraftModel = (currentProvider: AgentProvider, nextModel: string, currentDraft: string) => (
  currentProvider === 'ollama' ? nextModel : currentDraft
);

export const resolveOllamaFallbackSelectedModel = (
  currentDraftModel: string,
  savedRuntimeModel: string,
  fallbackModelIds: string[],
  defaultSelectedModel: string,
) => {
  if (fallbackModelIds.length === 0) return defaultSelectedModel;
  if (currentDraftModel && fallbackModelIds.includes(currentDraftModel)) return currentDraftModel;
  if (savedRuntimeModel && fallbackModelIds.includes(savedRuntimeModel)) return savedRuntimeModel;
  return fallbackModelIds[0];
};

export const buildSaveDefaultsPayload = (
  settings: Awaited<ReturnType<typeof getAgentSettings>>,
  currentProvider: AgentProvider,
  selectedModel: string,
  baseUrlInput: string,
  generationTimeoutMinutes?: number,
  idleTimeoutMinutes?: number,
) => {
  const canonicalBaseUrl = baseUrlInput.trim() || LOCAL_BASE_URL_DEFAULT;
  const canonicalModel = selectedModel.trim();
  const resolvedGenerateMinutes = Number.isFinite(generationTimeoutMinutes) ? Math.max(1, Math.floor(generationTimeoutMinutes as number)) : 30;
  const resolvedIdleMinutes = Number.isFinite(idleTimeoutMinutes) ? Math.max(1, Math.floor(idleTimeoutMinutes as number)) : 3;
  const providerTimeouts = {
    ...(settings.generation_params?.provider_timeouts ?? {}),
    generate_minutes: resolvedGenerateMinutes,
    generate_idle_minutes: resolvedIdleMinutes,
    generate_ms: resolvedGenerateMinutes * 60_000,
    generate_idle_ms: resolvedIdleMinutes * 60_000,
  };
  return {
    ...settings,
    default_provider: currentProvider,
    default_model: canonicalModel,
    generation_params: {
      ...(settings.generation_params ?? {}),
      provider_timeouts: providerTimeouts,
    },
    ...(currentProvider === 'ollama'
      ? {
          generation_params: {
            ...(settings.generation_params ?? {}),
            provider_timeouts: providerTimeouts,
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
