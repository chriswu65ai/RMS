import { Download, Upload } from 'lucide-react';
import { type ChangeEvent, useEffect, useState } from 'react';
import { useDialog } from '../../components/ui/DialogProvider';
import { useResearchStore } from '../../hooks/useResearchStore';
import { createFile, createFolder, getAttachmentSettings, runAttachmentCleanupNow, saveAttachmentSettings } from '../../lib/dataApi';
import { exportWorkspaceMarkdownZip, readMarkdownEntriesFromImport } from '../../lib/exportMarkdown';
import { splitFrontmatter } from '../../lib/frontmatter';
import { createUiAsyncGuard, runUiAsync } from '../../lib/uiAsync';
import type { Folder } from '../../types/models';

export function SettingsPage() {
  const { workspace, files, folders, refresh, noteTypes, setNoteTypes, assignees, setAssignees, sectors, setSectors } = useResearchStore();
  const dialog = useDialog();
  const [noteTypesInput, setNoteTypesInput] = useState(noteTypes.join(', '));
  const [assigneesInput, setAssigneesInput] = useState(assignees.join(', '));
  const [sectorsInput, setSectorsInput] = useState(sectors.join(', '));
  const [importTargetFolderId, setImportTargetFolderId] = useState<string>('');
  const [importing, setImporting] = useState(false);
  const [attachmentQuotaMb, setAttachmentQuotaMb] = useState(500);
  const [attachmentRetentionDays, setAttachmentRetentionDays] = useState(30);
  const [attachmentUsageBytes, setAttachmentUsageBytes] = useState(0);
  const [attachmentReclaimableBytes, setAttachmentReclaimableBytes] = useState(0);
  const [attachmentStatusError, setAttachmentStatusError] = useState<string | null>(null);
  const [attachmentsLoading, setAttachmentsLoading] = useState(true);

  useEffect(() => setNoteTypesInput(noteTypes.join(', ')), [noteTypes]);
  useEffect(() => setAssigneesInput(assignees.join(', ')), [assignees]);
  useEffect(() => setSectorsInput(sectors.join(', ')), [sectors]);
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

  const exportAllFiles = async () => {
    if (!workspace) return;
    if (files.length === 0) {
      await dialog.alert('Nothing to export', 'Create at least one stock research note before exporting.');
      return;
    }
    await exportWorkspaceMarkdownZip(workspace, files);
  };

  const ensureFolderPath = async (workspaceId: string, path: string, rootFolder: Folder | null) => {
    const parts = path.split('/').filter(Boolean);
    let parent = rootFolder;

    for (const part of parts) {
      const expectedPath = parent ? `${parent.path}/${part}` : part;
      const existing = useResearchStore.getState().folders.find((folder) => folder.path === expectedPath);
      if (existing) {
        parent = existing;
        continue;
      }

      const { error } = await createFolder(workspaceId, part, parent);
      if (error) throw new Error(error.message);
      await refresh();
      const created = useResearchStore.getState().folders.find((folder) => folder.path === expectedPath);
      if (!created) throw new Error(`Failed to create folder: ${expectedPath}`);
      parent = created;
    }

    return parent;
  };

  const importMarkdownFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!selected || !workspace) return;

    setImporting(true);
    try {
      const importedEntries = await readMarkdownEntriesFromImport(selected);
      if (importedEntries.length === 0) {
        await dialog.alert('No markdown files found', 'The selected file did not contain any .md files to import.');
        return;
      }

      const currentFolders = useResearchStore.getState().folders;
      const baseFolder = importTargetFolderId
        ? (currentFolders.find((folder) => folder.id === importTargetFolderId) ?? null)
        : null;

      let importedCount = 0;
      let skippedCount = 0;
      let rejectedCount = 0;

      for (const entry of importedEntries) {
        const cleanPath = entry.path.replace(/^\/+/, '').replace(/\\/g, '/');
        const pathParts = cleanPath
          .split('/')
          .map((segment) => segment.trim())
          .filter(Boolean);
        if (pathParts.some((segment) => segment === '.' || segment === '..')) {
          rejectedCount += 1;
          continue;
        }
        const fileNameWithExt = pathParts[pathParts.length - 1] ?? 'untitled.md';
        const folderPathFromImport = pathParts.slice(0, -1).join('/');
        const targetFolder = folderPathFromImport
          ? await ensureFolderPath(workspace.id, folderPathFromImport, baseFolder)
          : baseFolder;

        const fileName = fileNameWithExt.toLowerCase().endsWith('.md') ? fileNameWithExt : `${fileNameWithExt}.md`;
        const finalPath = targetFolder ? `${targetFolder.path}/${fileName}` : fileName;
        const existingFiles = useResearchStore.getState().files;
        if (existingFiles.some((file) => file.path === finalPath)) {
          skippedCount += 1;
          continue;
        }

        const parsed = splitFrontmatter(entry.content);
        const importedAsTemplate = parsed.frontmatter.template === true;
        const { error } = await createFile({
          workspaceId: workspace.id,
          folderId: targetFolder?.id ?? null,
          folderPath: targetFolder?.path ?? null,
          name: fileName,
          content: entry.content,
          isTemplate: importedAsTemplate,
          frontmatter: Object.keys(parsed.frontmatter).length > 0 ? parsed.frontmatter : null,
        });
        if (error) throw new Error(error.message);
        importedCount += 1;
      }

      await refresh();
      const duplicateSummary = `${skippedCount} duplicate${skippedCount === 1 ? '' : 's'} skipped`;
      const rejectedSummary = `${rejectedCount} invalid path entr${rejectedCount === 1 ? 'y' : 'ies'} rejected`;
      await dialog.alert(
        'Import complete',
        `Imported ${importedCount} file${importedCount === 1 ? '' : 's'} (${duplicateSummary}, ${rejectedSummary}).`,
      );
    } catch (error) {
      await dialog.alert('Import failed', error instanceof Error ? error.message : 'Unknown import error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Metadata</h2>
          <div className="w-full rounded-xl border border-slate-200 bg-white p-5">
            <div className="grid gap-4 md:grid-cols-3">
              <section className="space-y-3">
                <p className="text-sm text-slate-600">Note type</p>
                <input className="input" value={noteTypesInput} onChange={(event) => setNoteTypesInput(event.target.value)} onBlur={() => {
                  const next = noteTypesInput.split(',').map((value) => value.trim()).filter(Boolean);
                  setNoteTypes(next);
                  setNoteTypesInput(next.join(', '));
                }} placeholder="Event, Earnings, Deepdive, Summary" />
              </section>

              <section className="space-y-3">
                <p className="text-sm text-slate-600">Assignees</p>
                <input className="input" value={assigneesInput} onChange={(event) => setAssigneesInput(event.target.value)} onBlur={() => {
                  const next = assigneesInput.split(',').map((value) => value.trim()).filter(Boolean);
                  setAssignees(next);
                  setAssigneesInput(next.join(', '));
                }} placeholder="Agent, Me" />
              </section>

              <section className="space-y-3">
                <p className="text-sm text-slate-600">Sectors</p>
                <input className="input" value={sectorsInput} onChange={(event) => setSectorsInput(event.target.value)} onBlur={() => {
                  const next = sectorsInput.split(',').map((value) => value.trim()).filter(Boolean);
                  setSectors(next);
                  setSectorsInput(next.join(', '));
                }} placeholder="Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Health Care, Financials, Information Technology, Communication Services, Utilities, Real Estate" />
              </section>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Attachments</h2>
          <div className="w-full rounded-xl border border-slate-200 bg-white p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm text-slate-600">
                <span>Total storage quota (MB)</span>
                <input className="input" type="number" min={50} value={attachmentQuotaMb} disabled={attachmentsLoading} onChange={(event) => setAttachmentQuotaMb(Number(event.target.value || 500))} onBlur={async () => {
                  await runUiAsync(
                    () => saveAttachmentSettings({ quota_mb: attachmentQuotaMb, retention_days: attachmentRetentionDays }),
                    {
                      fallbackMessage: 'Failed to save attachment settings.',
                      onSuccess: (updated) => {
                        setAttachmentQuotaMb(updated.quota_mb);
                        setAttachmentRetentionDays(updated.retention_days);
                        setAttachmentUsageBytes(updated.usage_bytes);
                        setAttachmentReclaimableBytes(updated.reclaimable_bytes);
                        setAttachmentStatusError(null);
                      },
                      onError: (message) => setAttachmentStatusError(message),
                    },
                  );
                }} />
              </label>
              <label className="space-y-2 text-sm text-slate-600">
                <span>Retention days</span>
                <input className="input" type="number" min={1} value={attachmentRetentionDays} disabled={attachmentsLoading} onChange={(event) => setAttachmentRetentionDays(Number(event.target.value || 30))} onBlur={async () => {
                  await runUiAsync(
                    () => saveAttachmentSettings({ quota_mb: attachmentQuotaMb, retention_days: attachmentRetentionDays }),
                    {
                      fallbackMessage: 'Failed to save attachment settings.',
                      onSuccess: (updated) => {
                        setAttachmentQuotaMb(updated.quota_mb);
                        setAttachmentRetentionDays(updated.retention_days);
                        setAttachmentUsageBytes(updated.usage_bytes);
                        setAttachmentReclaimableBytes(updated.reclaimable_bytes);
                        setAttachmentStatusError(null);
                      },
                      onError: (message) => setAttachmentStatusError(message),
                    },
                  );
                }} />
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
            <button className="mt-3 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60" disabled={attachmentsLoading} onClick={async () => {
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
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Backup</h2>
          <div className="w-full rounded-xl border border-slate-200 bg-white p-5">
            <div className="grid gap-4 md:grid-cols-3">
              <section className="space-y-3">
                <p className="text-sm text-slate-600">Import markdown</p>
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  Target folder
                  <select className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={importTargetFolderId} onChange={(event) => setImportTargetFolderId(event.target.value)}>
                    <option value="">Root</option>
                    {folders.slice().sort((a, b) => a.path.localeCompare(b.path)).map((folder) => (
                      <option key={folder.id} value={folder.id}>{folder.path}</option>
                    ))}
                  </select>
                </label>
                <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50">
                  <Upload size={16} /> {importing ? 'Importing…' : 'Import .md/.zip'}
                  <input type="file" className="hidden" accept=".md,.zip" disabled={importing} onChange={importMarkdownFiles} />
                </label>
              </section>

              <section className="space-y-3">
                <p className="text-sm text-slate-600">Export markdown</p>
                <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50" onClick={exportAllFiles}>
                  <Download size={16} /> Export markdown
                </button>
              </section>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
