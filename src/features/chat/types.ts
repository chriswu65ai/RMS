export type ChatRole = 'user' | 'assistant';

export type ToolTraceStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ToolTraceEntry = {
  id: string;
  toolName: string;
  status: ToolTraceStatus;
  detail: string;
  startedAt: number;
  endedAt?: number;
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
