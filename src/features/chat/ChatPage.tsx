import { ArrowDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChatComposer } from './components/ChatComposer';
import { ChatMessageItem } from './components/ChatMessageItem';
import { CHAT_OVERLAY_CONTAINER_TEST_ID, JUMP_TO_LATEST_OVERLAY_CLASS, shouldShowJumpToLatest } from './chatLayout';
import { useChatStore } from '../../hooks/useChatStore';

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
  const sendMessage = useChatStore((state) => state.sendMessage);
  const retryMessage = useChatStore((state) => state.retryMessage);
  const cancelActive = useChatStore((state) => state.cancelActive);
  const [autoScrollLocked, setAutoScrollLocked] = useState(true);

  const showJumpToLatest = useMemo(() => shouldShowJumpToLatest(autoScrollLocked, messages.length), [autoScrollLocked, messages.length]);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  };

  useEffect(() => {
    if (autoScrollLocked) scrollToBottom(messages.length <= 1 ? 'auto' : 'smooth');
  }, [autoScrollLocked, messages]);

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
          {messages.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-600">
              Ask anything to start a chat. Tool traces and streamed deltas will appear inline.
            </div>
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
