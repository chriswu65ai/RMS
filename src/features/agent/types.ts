export type AgentProvider = 'minimax' | 'openai' | 'anthropic';

export const AGENT_PROVIDERS: AgentProvider[] = ['minimax', 'openai', 'anthropic'];

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
  | 'unsupported_endpoint'
  | 'auth_failed'
  | 'network_error'
  | 'empty_response';

export type AgentSettings = {
  default_provider: AgentProvider;
  default_model: string;
  generation_params?: {
    temperature?: number;
    maxTokens?: number;
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
