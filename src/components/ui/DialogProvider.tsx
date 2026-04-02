import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type DialogKind = 'alert' | 'confirm' | 'prompt';

type DialogState = {
  kind: DialogKind;
  title: string;
  message?: string;
  defaultValue?: string;
  options?: string[];
  validate?: (value: string) => string | null;
  resolve: (value: boolean | string | null) => void;
} | null;

type PromptOptions = {
  validate?: (value: string) => string | null;
  options?: string[];
};

type DialogAPI = {
  alert: (title: string, message?: string) => Promise<void>;
  confirm: (title: string, message?: string) => Promise<boolean>;
  prompt: (title: string, defaultValue?: string, message?: string, options?: PromptOptions) => Promise<string | null>;
};

const DialogContext = createContext<DialogAPI | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [inputValue, setInputValue] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const open = useCallback((kind: DialogKind, title: string, message?: string, defaultValue?: string, validate?: (value: string) => string | null, options?: string[]) => {
    return new Promise<boolean | string | null>((resolve) => {
      setInputValue(defaultValue ?? '');
      setValidationError(null);
      setDialog({ kind, title, message, defaultValue, validate, options, resolve });
    });
  }, []);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setValidationError(null);
  }, []);

  const resolvePrompt = useCallback(() => {
    if (!dialog || dialog.kind !== 'prompt') return;
    const error = dialog.validate?.(inputValue) ?? null;
    if (error) {
      setValidationError(error);
      return;
    }
    dialog.resolve(inputValue || null);
    closeDialog();
  }, [closeDialog, dialog, inputValue]);

  const api = useMemo<DialogAPI>(() => ({
    alert: async (title, message) => {
      await open('alert', title, message);
    },
    confirm: async (title, message) => open('confirm', title, message) as Promise<boolean>,
    prompt: async (title, defaultValue, message, options) => open('prompt', title, message, defaultValue, options?.validate, options?.options) as Promise<string | null>,
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
              dialog.options && dialog.options.length > 0 ? (
                <select
                  className="input mt-3"
                  autoFocus
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                >
                  {dialog.options.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="input mt-3"
                  autoFocus
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      resolvePrompt();
                    }
                  }}
                />
              )
            )}
            {dialog.kind === 'prompt' && validationError && (
              <p className="mt-2 text-sm text-red-600">{validationError}</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              {dialog.kind !== 'alert' && (
                <button
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                  onClick={() => {
                    dialog.resolve(dialog.kind === 'confirm' ? false : null);
                    closeDialog();
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white"
                onClick={() => {
                  if (dialog.kind === 'prompt') {
                    resolvePrompt();
                    return;
                  }
                  dialog.resolve(dialog.kind === 'confirm' ? true : true);
                  closeDialog();
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
