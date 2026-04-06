import { useEffect, useRef, useState } from 'react';
import { useDialog } from '../../components/ui/DialogProvider';
import { getAttachmentSettings, runAttachmentCleanupNow, saveAttachmentSettings } from '../../lib/dataApi';
import { createUiAsyncGuard, runUiAsync } from '../../lib/uiAsync';

export function SettingsAttachmentsPage() {
  const dialog = useDialog();
  const [attachmentQuotaMb, setAttachmentQuotaMb] = useState(500);
  const [attachmentRetentionDays, setAttachmentRetentionDays] = useState(30);
  const [attachmentUsageBytes, setAttachmentUsageBytes] = useState(0);
  const [attachmentReclaimableBytes, setAttachmentReclaimableBytes] = useState(0);
  const [attachmentStatusError, setAttachmentStatusError] = useState<string | null>(null);
  const [attachmentSaveStatus, setAttachmentSaveStatus] = useState<'idle' | 'saving' | 'success'>('idle');
  const [attachmentsLoading, setAttachmentsLoading] = useState(true);
  const attachmentSaveSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const guard = createUiAsyncGuard();
    void runUiAsync(
      () => getAttachmentSettings(),
      {
        fallbackMessage: 'Failed to load attachment settings.',
        isCancelled: guard.isCancelled,
        onSuccess: (settings) => {
          setAttachmentQuotaMb(settings.quota_mb);
          setAttachmentRetentionDays(settings.retention_days);
          setAttachmentUsageBytes(settings.usage_bytes);
          setAttachmentReclaimableBytes(settings.reclaimable_bytes);
          setAttachmentStatusError(null);
          setAttachmentsLoading(false);
        },
        onError: (message) => {
          setAttachmentStatusError(message);
          setAttachmentsLoading(false);
        },
      },
    );
    return () => guard.cancel();
  }, []);

  useEffect(() => () => {
    if (attachmentSaveSuccessTimeoutRef.current) {
      clearTimeout(attachmentSaveSuccessTimeoutRef.current);
      attachmentSaveSuccessTimeoutRef.current = null;
    }
  }, []);

  const saveAttachmentPreferences = async (nextPreferences?: { quota_mb?: number; retention_days?: number }) => {
    const preferencesToSave = {
      quota_mb: nextPreferences?.quota_mb ?? attachmentQuotaMb,
      retention_days: nextPreferences?.retention_days ?? attachmentRetentionDays,
    };
    setAttachmentQuotaMb(preferencesToSave.quota_mb);
    setAttachmentRetentionDays(preferencesToSave.retention_days);
    setAttachmentSaveStatus('saving');
    await runUiAsync(
      () => saveAttachmentSettings(preferencesToSave),
      {
        fallbackMessage: 'Failed to save attachment settings.',
        onSuccess: (updated) => {
          setAttachmentQuotaMb(updated.quota_mb);
          setAttachmentRetentionDays(updated.retention_days);
          setAttachmentUsageBytes(updated.usage_bytes);
          setAttachmentReclaimableBytes(updated.reclaimable_bytes);
          setAttachmentStatusError(null);
          setAttachmentSaveStatus('success');
          if (attachmentSaveSuccessTimeoutRef.current) {
            clearTimeout(attachmentSaveSuccessTimeoutRef.current);
          }
          attachmentSaveSuccessTimeoutRef.current = setTimeout(() => {
            setAttachmentSaveStatus('idle');
            attachmentSaveSuccessTimeoutRef.current = null;
          }, 2500);
        },
        onError: (message) => {
          setAttachmentStatusError(message);
          setAttachmentSaveStatus('idle');
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Attachments</h2>
      <div className="w-full rounded-xl border border-slate-200 bg-white p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm text-slate-600">
            <span>Total storage quota (MB)</span>
            <input className="input" type="number" min={50} value={attachmentQuotaMb} disabled={attachmentsLoading || attachmentSaveStatus === 'saving'} onChange={(event) => setAttachmentQuotaMb(Number(event.target.value || 500))} onBlur={() => void saveAttachmentPreferences({ quota_mb: attachmentQuotaMb })} />
          </label>
          <label className="space-y-2 text-sm text-slate-600">
            <span>Retention days</span>
            <input className="input" type="number" min={1} value={attachmentRetentionDays} disabled={attachmentsLoading || attachmentSaveStatus === 'saving'} onChange={(event) => setAttachmentRetentionDays(Number(event.target.value || 30))} onBlur={() => void saveAttachmentPreferences({ retention_days: attachmentRetentionDays })} />
          </label>
        </div>
        {attachmentsLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading attachment settings…</p>
        ) : (
          <>
            <p className="mt-3 text-sm text-slate-600">Current usage: {(attachmentUsageBytes / (1024 * 1024)).toFixed(2)} MB</p>
            <p className="text-sm text-slate-600">Reclaimable (soft-deleted): {(attachmentReclaimableBytes / (1024 * 1024)).toFixed(2)} MB</p>
          </>
        )}
        {attachmentStatusError && <p className="mt-2 text-sm text-rose-600">{attachmentStatusError}</p>}
        {attachmentSaveStatus === 'saving' && <p className="mt-2 text-sm text-slate-500">Saving attachment settings…</p>}
        {attachmentSaveStatus === 'success' && <p className="mt-2 text-sm text-emerald-600">Attachment settings saved.</p>}
        <button className="mt-3 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60" disabled={attachmentsLoading || attachmentSaveStatus === 'saving'} onClick={async () => {
          await runUiAsync(
            async () => {
              const result = await runAttachmentCleanupNow();
              const refreshed = await getAttachmentSettings();
              return { result, refreshed };
            },
            {
              fallbackMessage: 'Failed to run attachment cleanup.',
              onSuccess: async ({ result, refreshed }) => {
                setAttachmentUsageBytes(refreshed.usage_bytes);
                setAttachmentReclaimableBytes(refreshed.reclaimable_bytes);
                setAttachmentStatusError(null);
                await dialog.alert('Cleanup complete', `Removed ${result.removed_files} file(s), purged ${result.purged_attachments} attachment record(s).`);
              },
              onError: (message) => setAttachmentStatusError(message),
            },
          );
        }}>
          Run cleanup now
        </button>
      </div>
    </div>
  );
}
