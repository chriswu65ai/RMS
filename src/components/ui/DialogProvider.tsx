import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type DialogKind = 'alert' | 'confirm' | 'prompt';

type DialogState = {
  kind: DialogKind;
  title: string;
  message?: string;
  defaultValue?: string;
  resolve: (value: boolean | string | null) => void;
} | null;

type DialogAPI = {
  alert: (title: string, message?: string) => Promise<void>;
  confirm: (title: string, message?: string) => Promise<boolean>;
  prompt: (title: string, defaultValue?: string, message?: string) => Promise<string | null>;
};

const DialogContext = createContext<DialogAPI | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [inputValue, setInputValue] = useState('');

  const open = useCallback((kind: DialogKind, title: string, message?: string, defaultValue?: string) => {
    return new Promise<boolean | string | null>((resolve) => {
      setInputValue(defaultValue ?? '');
      setDialog({ kind, title, message, defaultValue, resolve });
    });
  }, []);

  const api = useMemo<DialogAPI>(() => ({
    alert: async (title, message) => {
      await open('alert', title, message);
    },
    confirm: async (title, message) => open('confirm', title, message) as Promise<boolean>,
    prompt: async (title, defaultValue, message) => open('prompt', title, message, defaultValue) as Promise<string | null>,
  }), [open]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <h3 className="text-sm font-semibold text-slate-900">{dialog.title}</h3>
            {dialog.message && <p className="mt-2 text-sm text-slate-600">{dialog.message}</p>}
            {dialog.kind === 'prompt' && (
              <input
                className="input mt-3"
                autoFocus
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    dialog.resolve(inputValue || null);
                    setDialog(null);
                  }
                }}
              />
            )}
            <div className="mt-4 flex justify-end gap-2">
              {dialog.kind !== 'alert' && (
                <button
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                  onClick={() => {
                    dialog.resolve(dialog.kind === 'confirm' ? false : null);
                    setDialog(null);
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white"
                onClick={() => {
                  dialog.resolve(dialog.kind === 'confirm' ? true : dialog.kind === 'prompt' ? (inputValue || null) : true);
                  setDialog(null);
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within DialogProvider');
  return ctx;
}
