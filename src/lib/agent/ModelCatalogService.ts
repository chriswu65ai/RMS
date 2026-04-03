import { listModels } from '../agentApi';
import type { AgentProvider, ModelListItem } from '../../features/agent/types';

export class ModelCatalogService {
  async listModels(provider: AgentProvider): Promise<{ models: ModelListItem[]; source: 'provider' | 'fallback'; reason?: string | null }> {
    const result = await listModels(provider);
    return {
      models: result.models,
      source: result.source,
      reason: result.reason,
    };
  }
}
