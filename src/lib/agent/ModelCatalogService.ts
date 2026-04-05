import { listModels } from '../agentApi';
import type { AgentProvider, ModelCatalogReasonCode, ModelListItem } from '../../features/agent/types';

export class ModelCatalogService {
  async listModels(provider: AgentProvider, runtimeBaseUrl?: string): Promise<{
    models: ModelListItem[];
    selectedModel: string;
    catalogStatus: 'live' | 'unsupported' | 'failed';
    selectionSource: 'live_catalog' | 'provider_fallback';
    reasonCode: ModelCatalogReasonCode;
  }> {
    const result = await listModels(provider, runtimeBaseUrl);
    return {
      models: result.models,
      selectedModel: result.selected_model,
      catalogStatus: result.catalog_status,
      selectionSource: result.selection_source,
      reasonCode: result.reason_code,
    };
  }
}
