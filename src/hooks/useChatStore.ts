import { create } from 'zustand';
import type { ChatMessage, ToolTraceEntry, ToolTraceStatus } from '../features/chat/types';

type StreamContext = {
  assistantMessageId: string;
  prompt: string;
  abortController: AbortController;
  timers: number[];
};

type ChatStore = {
  messages: ChatMessage[];
  running: boolean;
  lastError: string | null;
  sendMessage: (prompt: string) => void;
  retryMessage: (messageId: string) => void;
  cancelActive: () => void;
  clearError: () => void;
};

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const now = () => Date.now();

const demoResponseForPrompt = (prompt: string) => {
  const cleaned = prompt.trim();
  return [
    `Here's a working pass on: “${cleaned}”.`,
    'I kept the response concise, then added implementation details, tradeoffs, and next-step checks.',
    'If you want, I can now turn this into production-ready code and tests.',
  ].join(' ');
};

const failPrompt = (prompt: string) => /(^|\s)(fail|error)(\s|$)/i.test(prompt);

const updateMessage = (messages: ChatMessage[], id: string, updater: (message: ChatMessage) => ChatMessage) => messages.map((m) => m.id === id ? updater(m) : m);

const appendTrace = (messages: ChatMessage[], messageId: string, entry: ToolTraceEntry) => updateMessage(messages, messageId, (message) => ({ ...message, traces: [...message.traces, entry] }));

const updateTraceStatus = (messages: ChatMessage[], messageId: string, traceId: string, status: ToolTraceStatus, detail: string) => updateMessage(messages, messageId, (message) => ({
  ...message,
  traces: message.traces.map((trace) => trace.id === traceId ? { ...trace, status, detail, endedAt: status === 'running' || status === 'pending' ? undefined : now() } : trace),
}));

let activeStream: StreamContext | null = null;

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  running: false,
  lastError: null,
  sendMessage: (prompt) => {
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
    const timers: number[] = [];

    activeStream = { assistantMessageId, prompt: trimmed, abortController, timers };
    set((state) => ({ messages: [...state.messages, userMessage, assistantMessage], running: true, lastError: null }));

    const traceAId = makeId();
    const traceBId = makeId();
    setTimeout(() => {
      set((state) => ({
        messages: appendTrace(state.messages, assistantMessageId, {
          id: traceAId,
          toolName: 'query-planner',
          status: 'running',
          detail: 'Planning retrieval and response outline…',
          startedAt: now(),
        }),
      }));
    }, 80);

    const response = demoResponseForPrompt(trimmed);
    const chunks = response.match(/.{1,12}(\s|$)/g) ?? [response];

    chunks.forEach((chunk, index) => {
      const timer = window.setTimeout(() => {
        if (abortController.signal.aborted) return;
        set((state) => ({
          messages: updateMessage(state.messages, assistantMessageId, (message) => ({
            ...message,
            text: `${message.text}${chunk}`,
          })),
        }));

        if (index === Math.floor(chunks.length / 3)) {
          set((state) => ({ messages: updateTraceStatus(state.messages, assistantMessageId, traceAId, 'completed', 'Plan complete.') }));
          set((state) => ({
            messages: appendTrace(state.messages, assistantMessageId, {
              id: traceBId,
              toolName: 'synthesis-engine',
              status: 'running',
              detail: 'Synthesizing final response from deltas…',
              startedAt: now(),
            }),
          }));
        }

        if (index === chunks.length - 1) {
          if (failPrompt(trimmed)) {
            set((state) => ({
              running: false,
              lastError: 'The stream failed before completion. You can retry.',
              messages: updateMessage(state.messages, assistantMessageId, (message) => ({
                ...message,
                status: 'error',
                errorMessage: 'Generation failed. Retry to run again.',
              })).map((message) => message.id === assistantMessageId
                ? {
                  ...message,
                  traces: message.traces.map((trace) => trace.status === 'running'
                    ? { ...trace, status: 'failed', detail: 'Tool failed before completion.', endedAt: now() }
                    : trace),
                }
                : message),
            }));
          } else {
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
          }
          activeStream = null;
        }
      }, 220 * (index + 1));
      timers.push(timer);
    });
  },
  retryMessage: (messageId) => {
    const message = get().messages.find((entry) => entry.id === messageId);
    if (!message?.retryablePrompt) return;
    get().sendMessage(message.retryablePrompt);
  },
  cancelActive: () => {
    if (!activeStream) return;
    activeStream.abortController.abort();
    activeStream.timers.forEach((timerId) => window.clearTimeout(timerId));
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
}));
