export type ChatRole = 'user' | 'assistant' | 'system';

export type ToolTraceStatus =
  | 'pending'
  | 'running'
  | 'needs_confirmation'
  | 'needs_disambiguation'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ToolTraceEntry = {
  id: string;
  toolName: string;
  status: ToolTraceStatus;
  detail: string;
  startedAt: number;
  endedAt?: number;
  metadata?: Record<string, unknown>;
};

export type ChatMessageStatus = 'idle' | 'streaming' | 'error' | 'cancelled';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  status: ChatMessageStatus;
  errorMessage?: string;
  traces: ToolTraceEntry[];
  retryablePrompt?: string;
  metadata?: Record<string, unknown>;
};
