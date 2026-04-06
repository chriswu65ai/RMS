import { SendHorizonal, Square } from 'lucide-react';
import { useId, useState } from 'react';

export function ChatComposer({ running, onSend, onCancel }: { running: boolean; onSend: (text: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState('');
  const textareaId = useId();

  const submit = () => {
    const trimmed = draft.trim();
    if (!trimmed || running) return;
    onSend(trimmed);
    setDraft('');
  };

  return (
    <div className="border-t border-slate-200 bg-white/90 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
        <label className="sr-only" htmlFor={textareaId}>
          Message
        </label>
        <textarea
          id={textareaId}
          className="input max-h-40 min-h-[56px] resize-y"
          placeholder="Type your message…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {running ? (
          <button className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-700 hover:bg-amber-100" onClick={onCancel} aria-label="Cancel response">
            <Square size={16} />
          </button>
        ) : (
          <button className="rounded-lg bg-slate-900 p-3 text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300" disabled={!draft.trim()} onClick={submit} aria-label="Send message">
            <SendHorizonal size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
