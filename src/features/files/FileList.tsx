import { CopyPlus, FilePlus2, Pencil, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { splitFrontmatter } from '../../lib/frontmatter';
import { createFile, deleteFile, updateFile } from '../../lib/dataApi';
import { usePromptStore } from '../../hooks/usePromptStore';
import { useDialog } from '../../components/ui/DialogProvider';

export function FileList({ openTemplatePicker }: { openTemplatePicker: () => void }) {
  const { files, folders, selectedFolderId, selectedTag, selectedFileId, selectFile, workspace, refresh, search, setSearch } = usePromptStore();
  const dialog = useDialog();
  const [moveFileId, setMoveFileId] = useState<string | null>(null);
  const [moveFolderId, setMoveFolderId] = useState<string>('');

  const visible = files.filter((file) => {
    const folderMatch = !selectedFolderId || file.folder_id === selectedFolderId;
    if (!folderMatch) return false;

    if (selectedTag) {
      const parsed = splitFrontmatter(file.content);
      const tags = Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : [];
      if (!tags.includes(selectedTag)) return false;
    }

    if (!search) return true;
    const q = search.toLowerCase();
    return file.name.toLowerCase().includes(q) || file.content.toLowerCase().includes(q);
  });

  const moveFile = useMemo(() => files.find((f) => f.id === moveFileId) ?? null, [files, moveFileId]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-slate-200 p-3">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 text-slate-400" size={16} />
          <input className="input pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search filename/content" />
        </div>
        <div className="flex gap-2">
          <button
            className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium hover:bg-slate-50"
            onClick={async () => {
              if (!workspace) return;
              const name = await dialog.prompt('Create prompt file', 'new-prompt.md', 'File name (include .md)');
              if (!name) return;
              const folder = folders.find((f) => f.id === selectedFolderId) ?? null;
              const duplicate = files.some((f) => f.path === `${folder?.path ? `${folder.path}/` : ''}${name}`);
              if (duplicate) return dialog.alert('Duplicate file', 'File name already exists in this location.');
              await createFile({ workspaceId: workspace.id, folderId: folder?.id ?? null, folderPath: folder?.path ?? null, name, content: '# New Prompt\n' });
              await refresh();
            }}
          >
            <FilePlus2 className="mr-1 inline" size={14} />New
          </button>
          <button className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium hover:bg-slate-50" onClick={openTemplatePicker}>From template</button>
        </div>
      </div>
      <div className="overflow-y-auto p-2">
        {visible.length === 0 && <p className="p-3 text-sm text-slate-500">No prompts found.</p>}
        {visible.map((file) => {
          const { frontmatter } = splitFrontmatter(file.content);
          return (
            <div key={file.id} className="group mb-1 flex items-center gap-2">
              <button
                className={`flex-1 rounded-lg px-3 py-2 text-left ${selectedFileId === file.id ? 'bg-white shadow-sm ring-1 ring-slate-200' : 'hover:bg-white'}`}
                onClick={() => selectFile(file.id)}
              >
                <p className="text-sm font-medium">{frontmatter.title || file.name}</p>
                <p className="line-clamp-1 text-xs text-slate-500">{file.path}</p>
              </button>
              <div className="hidden items-center gap-1 group-hover:flex">
                <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={async () => {
                  const name = await dialog.prompt('Rename file', file.name, 'New file name');
                  if (!name) return;
                  const folder = folders.find((f) => f.id === file.folder_id) ?? null;
                  const path = `${folder?.path ? `${folder.path}/` : ''}${name}`;
                  if (files.some((f) => f.id !== file.id && f.path === path)) return dialog.alert('Duplicate path', 'Another file already uses this path.');
                  await updateFile(file.id, { name, path });
                  await refresh();
                }}><Pencil size={14} /></button>
                <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={async () => {
                  const name = await dialog.prompt('Duplicate file', file.name.replace('.md', '-copy.md'), 'New duplicate file name');
                  if (!name || !workspace) return;
                  const folder = folders.find((f) => f.id === file.folder_id) ?? null;
                  await createFile({ workspaceId: workspace.id, folderId: folder?.id ?? null, folderPath: folder?.path ?? null, name, content: file.content, isTemplate: file.is_template });
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
                  if (files.some((f) => f.id !== moveFile.id && f.path === path)) {
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
