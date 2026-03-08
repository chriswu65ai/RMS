import { CopyPlus, FilePlus2, Pencil, Search, Trash2 } from 'lucide-react';
import { splitFrontmatter } from '../../lib/frontmatter';
import { createFile, deleteFile, updateFile } from '../../lib/dataApi';
import { usePromptStore } from '../../hooks/usePromptStore';

export function FileList({ openTemplatePicker }: { openTemplatePicker: () => void }) {
  const { files, folders, selectedFolderId, selectedFileId, selectFile, workspace, refresh, search, setSearch } = usePromptStore();

  const visible = files.filter((file) => {
    const folderMatch = !selectedFolderId || file.folder_id === selectedFolderId;
    if (!folderMatch) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return file.name.toLowerCase().includes(q) || file.content.toLowerCase().includes(q);
  });

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
              const name = window.prompt('File name (with .md)', 'new-prompt.md');
              if (!name) return;
              const folder = folders.find((f) => f.id === selectedFolderId) ?? null;
              const duplicate = files.some((f) => f.path === `${folder?.path ? `${folder.path}/` : ''}${name}`);
              if (duplicate) return window.alert('File name already exists in this location.');
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
                  const name = window.prompt('Rename file', file.name);
                  if (!name) return;
                  const folder = folders.find((f) => f.id === file.folder_id) ?? null;
                  const path = `${folder?.path ? `${folder.path}/` : ''}${name}`;
                  if (files.some((f) => f.id !== file.id && f.path === path)) return window.alert('Duplicate path.');
                  await updateFile(file.id, { name, path });
                  await refresh();
                }}><Pencil size={14} /></button>
                <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={async () => {
                  const name = window.prompt('Duplicate as', file.name.replace('.md', '-copy.md'));
                  if (!name || !workspace) return;
                  const folder = folders.find((f) => f.id === file.folder_id) ?? null;
                  await createFile({ workspaceId: workspace.id, folderId: folder?.id ?? null, folderPath: folder?.path ?? null, name, content: file.content, isTemplate: file.is_template, templateType: file.template_type });
                  await refresh();
                }}><CopyPlus size={14} /></button>
                <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={async () => {
                  const folderPath = window.prompt('Move to folder path (blank for root)', folders.find((f) => f.id === file.folder_id)?.path ?? '');
                  if (folderPath === null) return;
                  const dest = folders.find((f) => f.path === folderPath) ?? null;
                  const path = `${dest?.path ? `${dest.path}/` : ''}${file.name}`;
                  if (files.some((f) => f.id !== file.id && f.path === path)) return window.alert('Duplicate path.');
                  await updateFile(file.id, { folder_id: dest?.id ?? null, path });
                  await refresh();
                }}>↗</button>
                <button
                  className="rounded p-1 text-slate-500 hover:bg-slate-100"
                  onClick={async () => {
                    if (!window.confirm(`Delete ${file.name}?`)) return;
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
    </div>
  );
}
