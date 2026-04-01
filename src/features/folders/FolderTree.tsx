import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Download, FolderPlus, PanelLeftClose, PanelLeftOpen, Pencil, Settings, Tag, Trash2, Upload } from 'lucide-react';
import { type ChangeEvent, useMemo, useState } from 'react';
import { createFolder, createFile, deleteFolder, renameFolder } from '../../lib/dataApi';
import { usePromptStore } from '../../hooks/usePromptStore';
import { useDialog } from '../../components/ui/DialogProvider';
import { exportWorkspaceMarkdownZip, readMarkdownEntriesFromImport } from '../../lib/exportMarkdown';
import { splitFrontmatter } from '../../lib/frontmatter';
import type { Folder } from '../../types/models';

const TAG_FILTER_ALL = '__ALL_TAGGED__';
const TAG_FILTER_NONE = '__NO_TAGS__';

export function FolderTree({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { folders, selectedFolderId, selectFolder, workspace, files, refresh, selectedTag, selectTag } = usePromptStore();
  const dialog = useDialog();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [tagsCollapsed, setTagsCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importTargetFolderId, setImportTargetFolderId] = useState<string>('');
  const [importing, setImporting] = useState(false);

  const exportAllFiles = async () => {
    if (!workspace) return;
    if (files.length === 0) {
      await dialog.alert('Nothing to export', 'Create at least one prompt file before exporting.');
      return;
    }
    await exportWorkspaceMarkdownZip(workspace, files);
  };

  const ensureFolderPath = async (workspaceId: string, path: string, rootFolder: Folder | null) => {
    const parts = path.split('/').filter(Boolean);
    let parent = rootFolder;

    for (const part of parts) {
      const expectedPath = parent ? `${parent.path}/${part}` : part;
      const existing = folders.find((folder) => folder.path === expectedPath);
      if (existing) {
        parent = existing;
        continue;
      }

      const { error } = await createFolder(workspaceId, part, parent);
      if (error) throw new Error(error.message);
      await refresh();
      const created = usePromptStore.getState().folders.find((folder) => folder.path === expectedPath);
      if (!created) {
        throw new Error(`Failed to create folder: ${expectedPath}`);
      }
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

      const baseFolder = importTargetFolderId
        ? (folders.find((folder) => folder.id === importTargetFolderId) ?? null)
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

        const fileName = fileNameWithExt.toLowerCase().endsWith('.md')
          ? fileNameWithExt.slice(0, -3)
          : fileNameWithExt;
        const finalPath = targetFolder ? `${targetFolder.path}/${fileName}` : fileName;
        const isDuplicate = files.some((file) => file.path === finalPath);

        if (isDuplicate) {
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
      await dialog.alert(
        'Import complete',
        `Imported ${importedCount} file${importedCount === 1 ? '' : 's'}${
          skippedCount > 0 ? ` (${skippedCount} duplicate${skippedCount === 1 ? '' : 's'} skipped)` : ''
        }.`,
      );
    } catch (error) {
      await dialog.alert('Import failed', error instanceof Error ? error.message : 'Unknown import error');
    } finally {
      setImporting(false);
    }
  };

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, typeof folders>();
    const sortedFolders = [...folders].sort((a, b) => a.name.localeCompare(b.name));

    sortedFolders.forEach((folder) => {
      const key = folder.parent_id ?? null;
      const list = map.get(key) ?? [];
      list.push(folder);
      map.set(key, list);
    });

    return map;
  }, [folders]);

  const expandableFolderIds = useMemo(() => {
    const ids = new Set<string>();
    folders.forEach((folder) => {
      if ((childrenByParent.get(folder.id) ?? []).length > 0) {
        ids.add(folder.id);
      }
    });
    return ids;
  }, [childrenByParent, folders]);

  const allExpanded = useMemo(() => {
    if (expandableFolderIds.size === 0) return true;
    for (const id of expandableFolderIds) {
      if (collapsedIds.has(id)) return false;
    }
    return true;
  }, [collapsedIds, expandableFolderIds]);

  const tags = useMemo(() => {
    const map = new Map<string, number>();
    files.forEach((file) => {
      const parsed = splitFrontmatter(file.content);
      const items = Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : [];
      items.forEach((tag) => map.set(tag, (map.get(tag) ?? 0) + 1));
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  const toggleFolderExpanded = (folderId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const toggleAllSubfolders = () => {
    setCollapsedIds((prev) => {
      const hasExpanded = [...expandableFolderIds].some((id) => !prev.has(id));
      return hasExpanded ? new Set(expandableFolderIds) : new Set();
    });
  };


  const getFolderLabel = (folder: (typeof folders)[number]) => {
    const name = folder.name?.trim();
    if (name && !name.includes('/')) return name;
    const parts = folder.path.split('/').filter(Boolean);
    const fromPath = parts[parts.length - 1];
    return fromPath || folder.name || folder.path;
  };


  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center py-2">
        <button
          className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
          onClick={onToggleCollapsed}
          aria-label="Expand folders panel"
          title="Expand folders panel"
        >
          <PanelLeftOpen size={16} />
        </button>
        <div className="mt-auto border-t border-slate-200 pt-2">
          <button
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            title="Settings"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>
    );
  }

  const renderFolderNode = (folder: (typeof folders)[number], depth: number) => {
    const childFolders = childrenByParent.get(folder.id) ?? [];
    const hasChildren = childFolders.length > 0;
    const isCollapsed = collapsedIds.has(folder.id);
    const isExpanded = hasChildren && !isCollapsed;
    const count = files.filter((f) => f.folder_id === folder.id).length;

    return (
      <div key={folder.id}>
        <div className="group flex items-center gap-1" style={{ paddingLeft: `${depth * 14}px` }}>
          <button
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${hasChildren ? 'text-slate-500 hover:bg-slate-100' : 'text-transparent'}`}
            onClick={() => {
              if (hasChildren) toggleFolderExpanded(folder.id);
            }}
            aria-label={isExpanded ? `Collapse ${getFolderLabel(folder)}` : `Expand ${getFolderLabel(folder)}`}
          >
            {hasChildren ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span />}
          </button>
          <button
            className={`flex-1 rounded-lg px-2 py-2 text-left text-sm ${
              selectedFolderId === folder.id ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'
            }`}
            onClick={() => selectFolder(folder.id)}
          >
            {getFolderLabel(folder)} <span className="text-xs opacity-70">({count})</span>
          </button>
          <div className="hidden items-center gap-1 group-hover:flex">
            <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={async () => {
              const name = await dialog.prompt('Rename folder', getFolderLabel(folder), 'New folder name');
              if (!name) return;
              const newPath = folder.parent_id ? `${folders.find((f) => f.id === folder.parent_id)?.path}/${name}` : name;
              const { error } = await renameFolder(folder.id, name, newPath);
              if (error) return dialog.alert('Rename failed', error.message);
              await refresh();
            }}><Pencil size={14} /></button>
            <button
              className="rounded p-1 text-slate-500 hover:bg-slate-100"
              onClick={async () => {
                if (files.some((f) => f.folder_id === folder.id)) return dialog.alert('Folder not empty', 'Delete files in this folder first.');
                if (!(await dialog.confirm('Delete folder', `Delete folder ${getFolderLabel(folder)}?`))) return;
                await deleteFolder(folder.id);
                await refresh();
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {isExpanded && (
          <div className="space-y-1">
            {childFolders.map((child) => renderFolderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between py-2 pl-3 pr-4">
        <div className="flex items-center gap-1">
          <button
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
            onClick={onToggleCollapsed}
            aria-label="Collapse folders panel"
            title="Collapse folders panel"
          >
            <PanelLeftClose size={16} />
          </button>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Folders</h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="rounded-md p-1 text-slate-600 hover:bg-slate-100"
            title="Create new folder"
            aria-label="Create new folder"
            onClick={async () => {
              if (!workspace) return;
              const parent = folders.find((f) => f.id === selectedFolderId) ?? null;
              const name = await dialog.prompt('Create folder', '', `Folder name${parent ? ` (${parent.path}/...)` : ''}`);
              if (!name) return;
              const duplicate = folders.some((f) => f.path === `${parent?.path ? `${parent.path}/` : ''}${name}`);
              if (duplicate) return dialog.alert('Duplicate folder', 'Folder already exists.');
              await createFolder(workspace.id, name, parent);
              await refresh();
            }}
          >
            <FolderPlus size={16} />
          </button>
          <button
            className="rounded-md p-1 text-slate-600 hover:bg-slate-100"
            title={allExpanded ? 'Hide all sub-folders' : 'Expand all sub-folders'}
            onClick={toggleAllSubfolders}
            aria-label={allExpanded ? 'Hide all sub-folders' : 'Expand all sub-folders'}
          >
            {allExpanded ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
          </button>
        </div>
      </div>
      <button className="mx-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100" onClick={() => selectFolder(null)}>
        All prompts
      </button>
      <div className="space-y-1 overflow-y-auto p-2">
        {(childrenByParent.get(null) ?? []).map((folder) => renderFolderNode(folder, 0))}
      </div>

      <div className="mt-auto border-t border-slate-200 p-2">
        <div className="mb-2 flex items-center justify-between px-2">
          <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><Tag size={12} />Tags</h4>
          <button
            className="rounded-md p-1 text-slate-600 hover:bg-slate-100"
            title={tagsCollapsed ? 'Expand tags' : 'Hide tags'}
            aria-label={tagsCollapsed ? 'Expand tags' : 'Hide tags'}
            onClick={() => setTagsCollapsed((prev) => !prev)}
          >
            {tagsCollapsed ? <ChevronsUpDown size={16} /> : <ChevronsDownUp size={16} />}
          </button>
        </div>

        {!tagsCollapsed && (
          <>
            <button
              className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-sm ${selectedTag === TAG_FILTER_ALL ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
              onClick={() => selectTag(TAG_FILTER_ALL)}
            >
              All tags
            </button>
            <button
              className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-sm ${selectedTag === TAG_FILTER_NONE ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
              onClick={() => selectTag(TAG_FILTER_NONE)}
            >
              No tags
            </button>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {tags.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No tags yet.</p>}
              {tags.map(([tag, count]) => (
                <button
                  key={tag}
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selectedTag === tag ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
                  onClick={() => selectTag(tag)}
                >
                  {tag} <span className="text-xs opacity-70">({count})</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="border-t border-slate-200 p-2">
        <button
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={16} /> Settings
        </button>
      </div>

      {settingsOpen && (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-slate-900/30 p-0 md:items-center md:p-6">
          <div className="grid h-[50vh] w-full max-w-3xl grid-cols-1 overflow-hidden rounded-t-2xl bg-white md:h-[45vh] md:rounded-2xl">
            <div className="flex min-h-0 flex-col">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
                <h4 className="text-sm font-semibold">Settings</h4>
                <button onClick={() => setSettingsOpen(false)} className="text-sm text-slate-500">Close</button>
              </div>
              <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
                <section className="space-y-3">
                  <p className="text-sm text-slate-600">Workspace</p>
                  <button
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
                    onClick={exportAllFiles}
                  >
                    <Download size={16} /> Export All
                  </button>
                </section>

                <section className="space-y-3">
                  <p className="text-sm text-slate-600">Import markdown</p>
                  <p className="text-xs text-slate-500">Upload one <strong>.md</strong> file or an uncompressed <strong>.zip</strong> with <strong>.md</strong> files. Nested folders in the zip are preserved.</p>
                  <label className="flex flex-col gap-1 text-xs text-slate-600">
                    Target folder
                    <select
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                      value={importTargetFolderId}
                      onChange={(event) => setImportTargetFolderId(event.target.value)}
                    >
                      <option value="">Root</option>
                      {folders
                        .slice()
                        .sort((a, b) => a.path.localeCompare(b.path))
                        .map((folder) => (
                          <option key={folder.id} value={folder.id}>{folder.path}</option>
                        ))}
                    </select>
                  </label>
                  <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50">
                    <Upload size={16} /> {importing ? 'Importing…' : 'Import .md/.zip'}
                    <input
                      type="file"
                      className="hidden"
                      accept=".md,.zip"
                      disabled={importing}
                      onChange={importMarkdownFiles}
                    />
                  </label>
                </section>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
