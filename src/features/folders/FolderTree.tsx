import { FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { createFolder, deleteFolder } from '../../lib/dataApi';
import { supabase } from '../../lib/supabase';
import { usePromptStore } from '../../hooks/usePromptStore';

export function FolderTree() {
  const { folders, selectedFolderId, selectFolder, workspace, files, refresh } = usePromptStore();

  const sorted = useMemo(() => [...folders].sort((a, b) => a.path.localeCompare(b.path)), [folders]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Folders</h3>
        <button
          className="rounded-md p-1 hover:bg-slate-100"
          onClick={async () => {
            if (!workspace) return;
            const name = window.prompt('Folder name');
            if (!name) return;
            const parent = folders.find((f) => f.id === selectedFolderId) ?? null;
            const duplicate = folders.some((f) => f.path === `${parent?.path ? `${parent.path}/` : ''}${name}`);
            if (duplicate) return window.alert('Folder already exists.');
            await createFolder(workspace.id, name, parent);
            await refresh();
          }}
        >
          <FolderPlus size={16} />
        </button>
      </div>
      <button className="mx-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100" onClick={() => selectFolder(null)}>
        All prompts
      </button>
      <div className="space-y-1 overflow-y-auto p-2">
        {sorted.map((folder) => {
          const count = files.filter((f) => f.folder_id === folder.id).length;
          return (
            <div key={folder.id} className="group flex items-center gap-1">
              <button
                className={`flex-1 rounded-lg px-3 py-2 text-left text-sm ${
                  selectedFolderId === folder.id ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'
                }`}
                onClick={() => selectFolder(folder.id)}
              >
                {folder.path} <span className="text-xs opacity-70">({count})</span>
              </button>
              <div className="hidden items-center gap-1 group-hover:flex">
                <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={async () => {
                  const name = window.prompt('Rename folder', folder.name);
                  if (!name) return;
                  const newPath = folder.parent_id ? `${folders.find((f) => f.id === folder.parent_id)?.path}/${name}` : name;
                  const { error } = await supabase.from('folders').update({ name, path: newPath, updated_at: new Date().toISOString() }).eq('id', folder.id);
                  if (error) return window.alert(error.message);
                  await refresh();
                }}><Pencil size={14} /></button>
                <button
                  className="rounded p-1 text-slate-500 hover:bg-slate-100"
                  onClick={async () => {
                    if (files.some((f) => f.folder_id === folder.id)) return window.alert('Delete files in this folder first.');
                    if (!window.confirm(`Delete folder ${folder.name}?`)) return;
                    await deleteFolder(folder.id);
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
