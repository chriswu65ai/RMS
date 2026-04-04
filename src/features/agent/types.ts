export type AgentProvider = 'minimax' | 'openai' | 'anthropic' | 'ollama';

export const AGENT_PROVIDERS: AgentProvider[] = ['minimax', 'openai', 'anthropic', 'ollama'];
export const CLOUD_AGENT_PROVIDERS = ['minimax', 'openai', 'anthropic'] as const;
export type CloudAgentProvider = typeof CLOUD_AGENT_PROVIDERS[number];

export const TriggerSource = {
  Manual: 'manual',
  Scheduled: 'scheduled',
} as const;

export const SaveMode = {
  ManualOnly: 'manual_only',
  AutoSave: 'auto_save',
} as const;

export type TriggerSource = typeof TriggerSource[keyof typeof TriggerSource];
export type SaveMode = typeof SaveMode[keyof typeof SaveMode];

export type ModelListItem = {
  modelId: string;
  displayName: string;
};

export type ModelCatalogReasonCode =
  | 'ok'
  | 'missing_api_key'
  | 'auth_failed'
  | 'rate_limited'
  | 'unsupported_endpoint'
  | 'network_error'
  | 'empty_response'
  | 'ollama_unreachable';

export type WebSearchProvider = 'duckduckgo';
export type WebSearchMode = 'single' | 'deep';
export type WebSearchRecency = 'any' | '7d' | '30d' | '365d';
export type WebSearchDomainPolicy = 'open_web' | 'prefer_list' | 'only_list';

export type AgentSettings = {
  default_provider: AgentProvider;
  default_model: string;
  generation_params?: {
    temperature?: number;
    maxTokens?: number;
    local_connection?: {
      base_url: string;
      model: string;
      B: number;
    };
    web_search?: {
      enabled: boolean;
      provider: WebSearchProvider;
      mode: WebSearchMode;
      max_results: number;
      timeout_ms: number;
      safe_search: boolean;
      recency: WebSearchRecency;
      domain_policy: WebSearchDomainPolicy;
    };
  } | null;
};

export type AgentActivityLog = {
  id: string;
  timestamp: string;
  note_id: string;
  action: string;
  trigger_source: TriggerSource;
  initiated_by: string;
  provider: string;
  model: string;
  status: 'started' | 'success' | 'failed' | 'cancelled';
  duration_ms: number | null;
  input_chars: number;
  output_chars: number;
  token_estimate: number | null;
  cost_estimate_usd: number | null;
  error_message_short: string | null;
};

export type PreferredSource = {
  id: string;
  domain: string;
  weight: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type CreatePreferredSourceInput = {
  domain: string;
  weight?: number;
  enabled?: boolean;
};

export type UpdatePreferredSourceInput = {
  domain?: string;
  weight?: number;
  enabled?: boolean;
};
