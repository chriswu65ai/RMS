import { RotateCcw } from 'lucide-react';
import type { ChatMessage } from '../types';
import { ToolTimeline } from './ToolTimeline';

export function ChatMessageItem({ message, onRetry }: { message: ChatMessage; onRetry: (messageId: string) => void }) {
  const isUser = message.role === 'user';
  const canRetry = Boolean(
    message.retryablePrompt
      && (message.status === 'error' || message.status === 'cancelled'),
  );
  const retryMessage = message.status === 'cancelled'
    ? (message.errorMessage ?? 'Generation was cancelled.')
    : (message.errorMessage ?? 'Something went wrong.');

  return (
    <article className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm ${isUser ? 'bg-slate-900 text-white' : 'border border-slate-200 bg-slate-50 text-slate-800'}`}>
        <p className="whitespace-pre-wrap leading-6">{message.text || (message.status === 'streaming' ? '…' : '')}</p>
        {message.role === 'assistant' ? <ToolTimeline traces={message.traces} /> : null}
        {canRetry ? (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5">
            <span className="text-xs text-rose-700">{retryMessage}</span>
            <button className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-100" onClick={() => onRetry(message.id)}>
              <RotateCcw size={12} /> Retry
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
