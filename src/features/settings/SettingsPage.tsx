import { Download, Upload } from 'lucide-react';
import { type ChangeEvent, useEffect, useState } from 'react';
import { useDialog } from '../../components/ui/DialogProvider';
import { usePromptStore } from '../../hooks/usePromptStore';
import { createFile, createFolder } from '../../lib/dataApi';
import { exportWorkspaceMarkdownZip, readMarkdownEntriesFromImport } from '../../lib/exportMarkdown';
import { splitFrontmatter } from '../../lib/frontmatter';
import type { Folder } from '../../types/models';

export function SettingsPage() {
  const { workspace, files, folders, refresh, noteTypes, setNoteTypes, assignees, setAssignees, sectors, setSectors } = usePromptStore();
  const dialog = useDialog();
  const [noteTypesInput, setNoteTypesInput] = useState(noteTypes.join(', '));
  const [assigneesInput, setAssigneesInput] = useState(assignees.join(', '));
  const [sectorsInput, setSectorsInput] = useState(sectors.join(', '));
  const [importTargetFolderId, setImportTargetFolderId] = useState<string>('');
  const [importing, setImporting] = useState(false);

  useEffect(() => setNoteTypesInput(noteTypes.join(', ')), [noteTypes]);
  useEffect(() => setAssigneesInput(assignees.join(', ')), [assignees]);
  useEffect(() => setSectorsInput(sectors.join(', ')), [sectors]);

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
      const existing = usePromptStore.getState().folders.find((folder) => folder.path === expectedPath);
      if (existing) {
        parent = existing;
        continue;
      }

      const { error } = await createFolder(workspaceId, part, parent);
      if (error) throw new Error(error.message);
      await refresh();
      const created = usePromptStore.getState().folders.find((folder) => folder.path === expectedPath);
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

      const currentFolders = usePromptStore.getState().folders;
      const baseFolder = importTargetFolderId
        ? (currentFolders.find((folder) => folder.id === importTargetFolderId) ?? null)
        : null;

      let importedCount = 0;
      let skippedCount = 0;

      for (const entry of importedEntries) {
        const cleanPath = entry.path.replace(/^\/+/, '').replace(/\\/g, '/');
        const pathParts = cleanPath.split('/').filter(Boolean);
        const fileNameWithExt = pathParts[pathParts.length - 1] ?? 'untitled.md';
        const folderPathFromImport = pathParts.slice(0, -1).join('/');
        const targetFolder = folderPathFromImport
          ? await ensureFolderPath(workspace.id, folderPathFromImport, baseFolder)
          : baseFolder;

        const fileName = fileNameWithExt.toLowerCase().endsWith('.md') ? fileNameWithExt : `${fileNameWithExt}.md`;
        const finalPath = targetFolder ? `${targetFolder.path}/${fileName}` : fileName;
        const existingFiles = usePromptStore.getState().files;
        if (existingFiles.some((file) => file.path === finalPath)) {
          skippedCount += 1;
          continue;
        }

        const parsed = splitFrontmatter(entry.content);
        const { error } = await createFile({
          workspaceId: workspace.id,
          folderId: targetFolder?.id ?? null,
          folderPath: targetFolder?.path ?? null,
          name: fileName,
          content: entry.content,
          frontmatter: Object.keys(parsed.frontmatter).length > 0 ? parsed.frontmatter : null,
        });
        if (error) throw new Error(error.message);
        importedCount += 1;
      }

      await refresh();
      await dialog.alert('Import complete', `Imported ${importedCount} file${importedCount === 1 ? '' : 's'}${skippedCount > 0 ? ` (${skippedCount} duplicate${skippedCount === 1 ? '' : 's'} skipped)` : ''}.`);
    } catch (error) {
      await dialog.alert('Import failed', error instanceof Error ? error.message : 'Unknown import error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-6">
          <section className="space-y-3">
            <p className="text-sm text-slate-600">Research workspace</p>
            <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50" onClick={exportAllFiles}>
              <Download size={16} /> Export all research notes
            </button>
          </section>

          <section className="space-y-3">
            <p className="text-sm text-slate-600">Research Types</p>
            <input className="input" value={noteTypesInput} onChange={(event) => setNoteTypesInput(event.target.value)} onBlur={() => {
              const next = noteTypesInput.split(',').map((value) => value.trim()).filter(Boolean);
              setNoteTypes(next);
              setNoteTypesInput(next.join(', '));
            }} placeholder="Research, Earnings, Valuation" />
          </section>

          <section className="space-y-3">
            <p className="text-sm text-slate-600">Assignees</p>
            <input className="input" value={assigneesInput} onChange={(event) => setAssigneesInput(event.target.value)} onBlur={() => {
              const next = assigneesInput.split(',').map((value) => value.trim()).filter(Boolean);
              setAssignees(next);
              setAssigneesInput(next.join(', '));
            }} placeholder="me, agent" />
          </section>

          <section className="space-y-3">
            <p className="text-sm text-slate-600">Sectors</p>
            <input className="input" value={sectorsInput} onChange={(event) => setSectorsInput(event.target.value)} onBlur={() => {
              const next = sectorsInput.split(',').map((value) => value.trim()).filter(Boolean);
              setSectors(next);
              setSectorsInput(next.join(', '));
            }} placeholder="Technology, Healthcare, Industrials" />
          </section>

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
        </div>
      </div>
    </div>
  );
}
