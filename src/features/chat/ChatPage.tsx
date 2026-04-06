import { ArrowDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PageState } from '../../components/shared/PageState';
import { useChatStore } from '../../hooks/useChatStore';
import { ChatComposer } from './components/ChatComposer';
import { ChatMessageItem } from './components/ChatMessageItem';
import { CHAT_OVERLAY_CONTAINER_TEST_ID, JUMP_TO_LATEST_OVERLAY_CLASS, shouldShowJumpToLatest } from './chatLayout';

const BOTTOM_LOCK_THRESHOLD = 80;

type JumpToLatestOverlayProps = {
  showJumpToLatest: boolean;
  onJumpToLatest: () => void;
};

export function JumpToLatestOverlay({ showJumpToLatest, onJumpToLatest }: JumpToLatestOverlayProps) {
  return (
    <div data-testid={CHAT_OVERLAY_CONTAINER_TEST_ID} className={JUMP_TO_LATEST_OVERLAY_CLASS}>
      {showJumpToLatest ? (
        <button
          className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 shadow hover:bg-slate-50"
          onClick={onJumpToLatest}
        >
          <ArrowDown size={14} /> Jump to latest
        </button>
      ) : null}
    </div>
  );
}

export function ChatPage() {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const messages = useChatStore((state) => state.messages);
  const running = useChatStore((state) => state.running);
  const initializing = useChatStore((state) => state.initializing);
  const lastError = useChatStore((state) => state.lastError);
  const clearError = useChatStore((state) => state.clearError);
  const hasOlderMessages = useChatStore((state) => state.hasOlderMessages);
  const loadOlderMessages = useChatStore((state) => state.loadOlderMessages);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const retryMessage = useChatStore((state) => state.retryMessage);
  const cancelActive = useChatStore((state) => state.cancelActive);
  const [autoScrollLocked, setAutoScrollLocked] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const showJumpToLatest = useMemo(() => shouldShowJumpToLatest(autoScrollLocked, messages.length), [autoScrollLocked, messages.length]);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  };

  useEffect(() => {
    if (autoScrollLocked) scrollToBottom(messages.length <= 1 ? 'auto' : 'smooth');
  }, [autoScrollLocked, messages]);

  const loadOlderDisabled = loadingOlder || initializing;

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-slate-50">
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4"
        onScroll={(event) => {
          const node = event.currentTarget;
          const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
          setAutoScrollLocked(distanceFromBottom < BOTTOM_LOCK_THRESHOLD);
        }}
      >
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {lastError ? (
            <div className="space-y-2">
              <PageState kind="error" message={lastError} />
              <button
                className="text-xs font-medium text-slate-600 underline hover:text-slate-800"
                onClick={clearError}
                type="button"
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {hasOlderMessages ? (
            <div className="flex justify-center">
              <button
                className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={loadOlderDisabled}
                onClick={async () => {
                  setLoadingOlder(true);
                  try {
                    await loadOlderMessages();
                  } finally {
                    setLoadingOlder(false);
                  }
                }}
                type="button"
              >
                {loadingOlder ? 'Loading older messages...' : 'Load older messages'}
              </button>
            </div>
          ) : null}

          {initializing ? <PageState kind="loading" message="Loading chat history..." /> : null}

          {!initializing && messages.length === 0 ? (
            <PageState kind="empty" message="Ask anything to start a chat. Tool traces and streamed deltas will appear inline." />
          ) : messages.map((message) => (
            <ChatMessageItem key={message.id} message={message} onRetry={retryMessage} />
          ))}
        </div>
      </div>

      <JumpToLatestOverlay
        showJumpToLatest={showJumpToLatest}
        onJumpToLatest={() => {
          setAutoScrollLocked(true);
          scrollToBottom();
        }}
      />

      <div className="sticky bottom-0">
        <ChatComposer running={running} onSend={sendMessage} onCancel={cancelActive} />
      </div>
    </section>
  );
}
