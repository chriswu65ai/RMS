import type { Attachment } from '../../types/models';

export type AttachmentDeleteScope = 'unlink' | 'workspace';

type Props = {
  open: boolean;
  attachment: Attachment | null;
  contextLabel: string;
  isBusy?: boolean;
  onClose: () => void;
  onConfirm: (scope: AttachmentDeleteScope) => void;
};

export function AttachmentDeleteDialog({
  open,
  attachment,
  contextLabel,
  isBusy = false,
  onClose,
  onConfirm,
}: Props) {
  if (!open || !attachment) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4" role="dialog" aria-modal="true" aria-label="Delete attachment options">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
        <h3 className="text-sm font-semibold text-slate-900">Delete attachment</h3>
        <p className="mt-2 text-sm text-slate-600">
          Choose how to delete <span className="font-medium text-slate-900">{attachment.original_name}</span>.
        </p>
        <div className="mt-4 space-y-2">
          <button
            className="w-full rounded border border-slate-300 px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            disabled={isBusy}
            onClick={() => onConfirm('unlink')}
          >
            Remove from this {contextLabel} only
          </button>
          <button
            className="w-full rounded border border-rose-300 px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            disabled={isBusy}
            onClick={() => onConfirm('workspace')}
          >
            Delete from workspace (all notes and tasks)
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button className="rounded border border-slate-300 px-3 py-1.5 text-sm" type="button" disabled={isBusy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
