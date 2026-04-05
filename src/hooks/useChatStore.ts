import { create } from 'zustand';
import type { ChatMessage, ChatRole, ToolTraceEntry, ToolTraceStatus } from '../features/chat/types';

type StreamContext = {
  assistantMessageId: string;
  abortController: AbortController;
};

type ChatHistoryRange = '24h' | '7d' | 'all';

type ChatApiMessage = {
  id: string;
  role: string;
  content: string;
  created_at: string;
};

type ChatMessagesResponse = {
  messages?: ChatApiMessage[];
};

type StreamPayload = {
  type?: string;
  deltaText?: string;
  message?: string;
  outputText?: string;
  toolName?: string;
  tool_name?: string;
  toolCallId?: string;
  tool_call_id?: string;
} & Record<string, unknown>;

type ChatStore = {
  messages: ChatMessage[];
  running: boolean;
  lastError: string | null;
  initialized: boolean;
  initializing: boolean;
  hasOlderMessages: boolean;
  sendMessage: (prompt: string) => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;
  cancelActive: () => void;
  clearError: () => void;
  loadInitialMessages: () => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  clearHistory: (range?: ChatHistoryRange) => Promise<void>;
  resetContext: () => Promise<void>;
  exportSession: (format?: 'json' | 'markdown') => Promise<unknown>;
};

const PAGE_SIZE = 50;
const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const now = () => Date.now();

const updateMessage = (messages: ChatMessage[], id: string, updater: (message: ChatMessage) => ChatMessage) => messages.map((m) => m.id === id ? updater(m) : m);

const appendTrace = (messages: ChatMessage[], messageId: string, entry: ToolTraceEntry) => updateMessage(messages, messageId, (message) => ({ ...message, traces: [...message.traces, entry] }));

const updateTraceStatus = (messages: ChatMessage[], messageId: string, traceId: string, status: ToolTraceStatus, detail: string) => updateMessage(messages, messageId, (message) => ({
  ...message,
  traces: message.traces.map((trace) => trace.id === traceId ? { ...trace, status, detail, endedAt: status === 'running' || status === 'pending' ? undefined : now() } : trace),
}));

const toUiRole = (role: string): ChatRole | null => {
  if (role === 'user' || role === 'assistant') return role;
  return null;
};

const mapApiMessage = (message: ChatApiMessage): ChatMessage | null => {
  const role = toUiRole(message.role);
  if (!role) return null;
  return {
    id: message.id,
    role,
    text: message.content,
    createdAt: Date.parse(message.created_at) || now(),
    status: 'idle',
    traces: [],
  };
};

const asErrorMessage = async (response: Response) => {
  try {
    const payload = await response.json() as { error?: { message?: string } | null };
    return payload.error?.message ?? 'Request failed.';
  } catch {
    return await response.text();
  }
};

const pickToolName = (payload: StreamPayload): string => (
  typeof payload.toolName === 'string'
    ? payload.toolName
    : (typeof payload.tool_name === 'string' ? payload.tool_name : 'tool')
);

const pickToolCallId = (payload: StreamPayload): string => (
  typeof payload.toolCallId === 'string'
    ? payload.toolCallId
    : (typeof payload.tool_call_id === 'string' ? payload.tool_call_id : makeId())
);

const markRunningTraces = (
  messages: ChatMessage[],
  messageId: string,
  status: Extract<ToolTraceStatus, 'cancelled' | 'failed' | 'completed'>,
  detail: string,
) => updateMessage(messages, messageId, (message) => ({
  ...message,
  traces: message.traces.map((trace) => trace.status === 'running'
    ? { ...trace, status, detail, endedAt: now() }
    : trace),
}));

let activeStream: StreamContext | null = null;

export const useChatStore = create<ChatStore>((set, get) => {
  const loadMessagesPage = async (before?: string) => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) query.set('before', before);
    const response = await fetch(`/api/chat/session/current/messages?${query.toString()}`);
    if (!response.ok) throw new Error(await asErrorMessage(response));
    return response.json() as Promise<ChatMessagesResponse>;
  };

  const store: ChatStore = {
    messages: [],
    running: false,
    lastError: null,
    initialized: false,
    initializing: false,
    hasOlderMessages: false,
    loadInitialMessages: async () => {
      set({ initializing: true, lastError: null });
      try {
        const payload = await loadMessagesPage();
        const mapped = (payload.messages ?? []).map(mapApiMessage).filter((entry): entry is ChatMessage => Boolean(entry));
        set({
          messages: mapped,
          initialized: true,
          initializing: false,
          hasOlderMessages: mapped.length >= PAGE_SIZE,
        });
      } catch (error) {
        set({
          initializing: false,
          initialized: true,
          lastError: error instanceof Error ? error.message : 'Failed loading chat history.',
        });
      }
    },
    loadOlderMessages: async () => {
      const oldest = get().messages[0];
      if (!oldest) return;
      try {
        const payload = await loadMessagesPage(oldest.id);
        const mapped = (payload.messages ?? []).map(mapApiMessage).filter((entry): entry is ChatMessage => Boolean(entry));
        const knownIds = new Set(get().messages.map((message) => message.id));
        const deduped = mapped.filter((message) => !knownIds.has(message.id));
        set((state) => ({
          messages: [...deduped, ...state.messages],
          hasOlderMessages: mapped.length >= PAGE_SIZE,
        }));
      } catch (error) {
        set({ lastError: error instanceof Error ? error.message : 'Failed loading older messages.' });
      }
    },
    sendMessage: async (prompt) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;

      get().cancelActive();

      const userMessage: ChatMessage = {
        id: makeId(),
        role: 'user',
        text: trimmed,
        createdAt: now(),
        status: 'idle',
        traces: [],
      };

      const assistantMessageId = makeId();
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        text: '',
        createdAt: now(),
        status: 'streaming',
        traces: [],
        retryablePrompt: trimmed,
      };

      const abortController = new AbortController();
      activeStream = { assistantMessageId, abortController };
      set((state) => ({ messages: [...state.messages, userMessage, assistantMessage], running: true, lastError: null }));

      try {
        const response = await fetch('/api/chat/session/current/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: trimmed }),
          signal: abortController.signal,
        });
        if (!response.ok) {
          throw new Error(await asErrorMessage(response));
        }
        if (!response.body) {
          set((state) => ({
            running: false,
            messages: updateMessage(state.messages, assistantMessageId, (message) => ({
              ...message,
              status: 'idle',
            })),
          }));
          activeStream = null;
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            let payload: StreamPayload;
            try {
              payload = JSON.parse(trimmedLine) as StreamPayload;
            } catch {
              continue;
            }

            if (payload.type === 'delta') {
              set((state) => ({
                messages: updateMessage(state.messages, assistantMessageId, (message) => ({
                  ...message,
                  text: `${message.text}${payload.deltaText ?? ''}`,
                })),
              }));
              continue;
            }

            if (payload.type === 'tool_call_started') {
              const traceId = pickToolCallId(payload);
              set((state) => ({
                messages: appendTrace(state.messages, assistantMessageId, {
                  id: traceId,
                  toolName: pickToolName(payload),
                  status: 'running',
                  detail: payload.message ?? 'Tool call started.',
                  startedAt: now(),
                }),
              }));
              continue;
            }

            if (payload.type === 'tool_call_result') {
              const traceId = pickToolCallId(payload);
              set((state) => ({
                messages: updateTraceStatus(
                  state.messages,
                  assistantMessageId,
                  traceId,
                  'completed',
                  payload.message ?? 'Tool call completed.',
                ),
              }));
              continue;
            }

            if (payload.type === 'tool_call_failed') {
              const traceId = pickToolCallId(payload);
              set((state) => ({
                messages: updateTraceStatus(
                  state.messages,
                  assistantMessageId,
                  traceId,
                  'failed',
                  payload.message ?? 'Tool call failed.',
                ),
              }));
              continue;
            }

            if (payload.type === 'done') {
              set((state) => ({
                running: false,
                messages: updateMessage(state.messages, assistantMessageId, (message) => ({
                  ...message,
                  text: payload.outputText ?? message.text,
                  status: 'idle',
                  traces: message.traces.map((trace) => trace.status === 'running'
                    ? { ...trace, status: 'completed', detail: 'Output finalized.', endedAt: now() }
                    : trace),
                })),
              }));
              activeStream = null;
              return;
            }

            if (payload.type === 'error') {
              const errorMessage = payload.message ?? 'The stream failed before completion. You can retry.';
              set((state) => ({
                running: false,
                lastError: errorMessage,
                messages: updateMessage(markRunningTraces(state.messages, assistantMessageId, 'failed', 'Tool failed before completion.'), assistantMessageId, (message) => ({
                  ...message,
                  status: 'error',
                  errorMessage,
                })),
              }));
              activeStream = null;
              return;
            }
          }
        }

        set((state) => ({
          running: false,
          messages: updateMessage(state.messages, assistantMessageId, (message) => ({
            ...message,
            status: 'idle',
            traces: message.traces.map((trace) => trace.status === 'running'
              ? { ...trace, status: 'completed', detail: 'Output finalized.', endedAt: now() }
              : trace),
          })),
        }));
      } catch (error) {
        if (abortController.signal.aborted) return;
        const errorMessage = error instanceof Error ? error.message : 'The stream failed before completion. You can retry.';
        set((state) => ({
          running: false,
          lastError: errorMessage,
          messages: updateMessage(markRunningTraces(state.messages, assistantMessageId, 'failed', 'Tool failed before completion.'), assistantMessageId, (message) => ({
            ...message,
            status: 'error',
            errorMessage,
          })),
        }));
      } finally {
        if (activeStream?.assistantMessageId === assistantMessageId) {
          activeStream = null;
        }
      }
    },
    retryMessage: async (messageId) => {
      const message = get().messages.find((entry) => entry.id === messageId);
      if (!message?.retryablePrompt) return;
      await get().sendMessage(message.retryablePrompt);
    },
    cancelActive: () => {
      if (!activeStream) return;
      activeStream.abortController.abort();
      set((state) => ({
        running: false,
        messages: updateMessage(state.messages, activeStream!.assistantMessageId, (message) => ({
          ...message,
          status: message.text.trim() ? 'cancelled' : 'error',
          errorMessage: message.text.trim() ? 'Cancelled by user.' : 'Cancelled before any output.',
          traces: message.traces.map((trace) => trace.status === 'running'
            ? { ...trace, status: 'cancelled', detail: 'Cancelled by user.', endedAt: now() }
            : trace),
        })),
      }));
      activeStream = null;
    },
    clearError: () => set({ lastError: null }),
    clearHistory: async (range = 'all') => {
      const response = await fetch(`/api/chat/session/current/history?range=${range}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await asErrorMessage(response));
      set({ messages: [], hasOlderMessages: false, lastError: null });
    },
    resetContext: async () => {
      const response = await fetch('/api/chat/session/current/reset-context', { method: 'POST' });
      if (!response.ok) throw new Error(await asErrorMessage(response));
      await get().loadInitialMessages();
    },
    exportSession: async (format = 'json') => {
      const response = await fetch(`/api/chat/session/current/export?format=${format}`);
      if (!response.ok) throw new Error(await asErrorMessage(response));
      if (format === 'markdown') {
        return response.text();
      }
      return response.json();
    },
  };

  queueMicrotask(() => {
    void store.loadInitialMessages();
  });

  return store;
});
