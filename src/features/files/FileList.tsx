import { CopyPlus, FilePlus2, Pencil, Star, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { composeMarkdown, splitFrontmatter } from '../../lib/frontmatter';
import { createFile, deleteFile, updateFile } from '../../lib/dataApi';
import { buildCanonicalStockFileName, toLocalDateInputValue, usePromptStore } from '../../hooks/usePromptStore';
import { useDialog } from '../../components/ui/DialogProvider';
import type { FrontmatterModel } from '../../types/models';

const SECTOR_FILTER_ALL = '__ALL_TAGGED__';
const SECTOR_FILTER_NONE = '__NO_TAGS__';

export function FileList({ openTemplatePicker }: { openTemplatePicker: () => void }) {
  const { files, folders, selectedFolderId, selectedTag, selectedFileId, selectFile, workspace, refresh, search, setSearch, noteTypes } = usePromptStore();
  const dialog = useDialog();
  const [moveFileId, setMoveFileId] = useState<string | null>(null);
  const [moveFolderId, setMoveFolderId] = useState<string>('');

  const visible = useMemo(() => {
    const filtered = files.filter((file) => {
      const folderMatch = !selectedFolderId || file.folder_id === selectedFolderId;
      if (!folderMatch) return false;

      if (selectedTag) {
        const parsed = splitFrontmatter(file.content);
        const sectors = Array.isArray(parsed.frontmatter.sectors) ? parsed.frontmatter.sectors : [];

        if (selectedTag === SECTOR_FILTER_ALL && sectors.length === 0) return false;
        if (selectedTag === SECTOR_FILTER_NONE && sectors.length > 0) return false;
        if (selectedTag !== SECTOR_FILTER_ALL && selectedTag !== SECTOR_FILTER_NONE && !sectors.includes(selectedTag)) return false;
      }

      if (!search) return true;
      const q = search.toLowerCase();
      return file.name.toLowerCase().includes(q) || file.content.toLowerCase().includes(q);
    });

    const starred: typeof filtered = [];
    const regular: typeof filtered = [];
    filtered.forEach((file) => {
      const { frontmatter } = splitFrontmatter(file.content);
      if (frontmatter.starred) starred.push(file);
      else regular.push(file);
    });

    return [...starred, ...regular];
  }, [files, search, selectedFolderId, selectedTag]);

  const moveFile = useMemo(() => files.find((f) => f.id === moveFileId) ?? null, [files, moveFileId]);

  const hasDuplicateInFolder = (folderId: string | null, fileName: string, currentFileId?: string) => {
    const normalizedName = fileName.toLowerCase();
    return files.some((file) => file.folder_id === folderId && file.name.toLowerCase() === normalizedName && file.id !== currentFileId);
  };

  const promptForCanonicalInputs = async () => {
    const tickerInput = await dialog.prompt('New stock research note', '', 'Ticker (required)');
    if (!tickerInput) return null;
    const typeInput = await dialog.prompt('New stock research note', noteTypes[0] ?? 'Research', `Type (${noteTypes.join(', ')})`);
    if (!typeInput) return null;
    const dateInput = await dialog.prompt('New stock research note', toLocalDateInputValue(), 'Date (YYYY-MM-DD)');
    if (!dateInput) return null;

    const ticker = tickerInput.trim().toUpperCase();
    const type = typeInput.trim();
    const date = dateInput.trim();
    if (!ticker || !type || !date) return null;

    return { ticker, type, date, fileName: buildCanonicalStockFileName(date, ticker, type) };
  };

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-slate-200 p-3">
        <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ticker/note content" />
        <div className="flex gap-2">
          <button
            className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium hover:bg-slate-50"
            onClick={async () => {
              if (!workspace) return;
              const payload = await promptForCanonicalInputs();
              if (!payload) return;
              const folder = folders.find((f) => f.id === selectedFolderId) ?? null;
              const duplicate = hasDuplicateInFolder(folder?.id ?? null, payload.fileName);
              if (duplicate) {
                await dialog.alert('Duplicate file', 'A stock research note with this ticker/date/type already exists in this folder.');
                return;
              }
              const frontmatter: FrontmatterModel = {
                title: `${payload.ticker} ${payload.type}`,
                ticker: payload.ticker,
                type: payload.type,
                date: payload.date,
                recommendation: '',
                stock_recommendation: '',
              };
              const content = composeMarkdown(frontmatter, '');
              const { error } = await createFile({ workspaceId: workspace.id, folderId: folder?.id ?? null, folderPath: folder?.path ?? null, name: payload.fileName, content, frontmatter });
              if (error) return dialog.alert('Create failed', error.message);
              await refresh();
            }}
          >
            <FilePlus2 className="mr-1 inline" size={14} />New note
          </button>
          <button className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium hover:bg-slate-50" onClick={openTemplatePicker}>
            <FilePlus2 className="mr-1 inline" size={14} />From template
          </button>
        </div>
      </div>
      <div className="overflow-y-auto p-2">
        {visible.length === 0 && <p className="p-3 text-sm text-slate-500">No stock research notes found.</p>}
        {visible.map((file) => {
          const { frontmatter } = splitFrontmatter(file.content);
          return (
            <div key={file.id} className="group mb-1 flex items-center gap-2">
              <button
                className={`flex-1 rounded-lg px-3 py-2 text-left ${selectedFileId === file.id ? 'bg-white shadow-sm ring-1 ring-slate-200' : 'hover:bg-white'}`}
                onClick={() => selectFile(file.id)}
              >
                <p className="flex items-center gap-1 text-sm font-medium">
                  <span>{frontmatter.title || file.name}</span>
                  {frontmatter.starred === true && <Star size={12} className="text-amber-500" fill="currentColor" />}
                </p>
                <p className="line-clamp-1 text-xs text-slate-500">{file.path.split('/').filter(Boolean).join('/') || file.name}</p>
              </button>
              <div className="hidden items-center gap-1 group-hover:flex">
                <button
                  className={`rounded p-1 ${frontmatter.starred === true ? 'text-amber-500' : 'text-slate-500'} hover:bg-slate-100`}
                  onClick={async () => {
                    const parsed = splitFrontmatter(file.content);
                    const nextFrontmatter: FrontmatterModel = { ...parsed.frontmatter };
                    const nextStarred = !parsed.frontmatter.starred;
                    if (nextStarred) nextFrontmatter.starred = true;
                    else delete nextFrontmatter.starred;
                    await updateFile(file.id, { content: composeMarkdown(nextFrontmatter, parsed.body), frontmatter_json: nextFrontmatter, is_template: !!nextFrontmatter.template });
                    await refresh();
                  }}
                  title={frontmatter.starred === true ? 'Unstar note' : 'Star note'}
                >
                  <Star size={14} fill={frontmatter.starred === true ? 'currentColor' : 'none'} />
                </button>
                <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={async () => {
                  const name = await dialog.prompt('Rename note file', file.name, 'New file name');
                  if (!name) return;
                  const folder = folders.find((f) => f.id === file.folder_id) ?? null;
                  const path = `${folder?.path ? `${folder.path}/` : ''}${name.trim()}`;
                  if (hasDuplicateInFolder(folder?.id ?? null, name.trim(), file.id)) return dialog.alert('Duplicate path', 'Another file already uses this path.');
                  await updateFile(file.id, { name: name.trim(), path });
                  await refresh();
                }}><Pencil size={14} /></button>
                <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={async () => {
                  const payload = await promptForCanonicalInputs();
                  if (!payload || !workspace) return;
                  const folder = folders.find((f) => f.id === file.folder_id) ?? null;
                  const duplicate = hasDuplicateInFolder(folder?.id ?? null, payload.fileName);
                  if (duplicate) return dialog.alert('Duplicate file', 'A file with this name already exists in this folder.');
                  const parsed = splitFrontmatter(file.content);
                  const clonedFrontmatter = { ...parsed.frontmatter, template: false, ticker: payload.ticker, type: payload.type, date: payload.date, title: `${payload.ticker} ${payload.type}` };
                  const clonedContent = composeMarkdown(clonedFrontmatter, parsed.body);
                  await createFile({ workspaceId: workspace.id, folderId: folder?.id ?? null, folderPath: folder?.path ?? null, name: payload.fileName, content: clonedContent, isTemplate: false, frontmatter: clonedFrontmatter });
                  await refresh();
                }}><CopyPlus size={14} /></button>
                <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={() => {
                  setMoveFileId(file.id);
                  setMoveFolderId(file.folder_id ?? '');
                }}>↗</button>
                <button
                  className="rounded p-1 text-slate-500 hover:bg-slate-100"
                  onClick={async () => {
                    if (!(await dialog.confirm('Delete file', `Delete ${file.name}?`))) return;
                    await deleteFile(file.id);
                    await refresh();
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {moveFile && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <h3 className="text-sm font-semibold">Move file</h3>
            <p className="mt-1 text-xs text-slate-500">Choose destination folder for <span className="font-medium text-slate-700">{moveFile.name}</span>.</p>
            <select className="input mt-3" value={moveFolderId} onChange={(e) => setMoveFolderId(e.target.value)}>
              <option value="">No folder (root)</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>{folder.path}</option>
              ))}
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded-md border border-slate-300 px-3 py-1.5 text-sm" onClick={() => setMoveFileId(null)}>Cancel</button>
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white"
                onClick={async () => {
                  const dest = folders.find((f) => f.id === moveFolderId) ?? null;
                  const path = `${dest?.path ? `${dest.path}/` : ''}${moveFile.name}`;
                  if (hasDuplicateInFolder(dest?.id ?? null, moveFile.name, moveFile.id)) {
                    await dialog.alert('Duplicate path', 'Another file already uses this path.');
                    return;
                  }
                  await updateFile(moveFile.id, { folder_id: dest?.id ?? null, path });
                  await refresh();
                  setMoveFileId(null);
                }}
              >
                Move
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
