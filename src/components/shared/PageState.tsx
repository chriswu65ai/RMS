export function PageState({ kind, message }: { kind: 'loading' | 'empty' | 'error'; message: string }) {
  const tone = kind === 'error'
    ? 'border-rose-200 bg-rose-50 text-rose-700'
    : 'border-slate-200 bg-slate-50 text-slate-500';
  return <p className={`rounded-lg border p-3 text-sm ${tone}`}>{message}</p>;
}
