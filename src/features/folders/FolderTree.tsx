import { Download, FolderPlus, Pencil, Tag, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { createFolder, deleteFolder } from '../../lib/dataApi';
import { supabase } from '../../lib/supabase';
import { usePromptStore } from '../../hooks/usePromptStore';
import { useDialog } from '../../components/ui/DialogProvider';
import { exportWorkspaceMarkdownZip } from '../../lib/exportMarkdown';
import { splitFrontmatter } from '../../lib/frontmatter';

export function FolderTree() {
  const { folders, selectedFolderId, selectFolder, workspace, files, refresh, selectedTag, selectTag } = usePromptStore();
  const dialog = useDialog();

  const sorted = useMemo(() => [...folders].sort((a, b) => a.path.localeCompare(b.path)), [folders]);

  const tags = useMemo(() => {
    const map = new Map<string, number>();
    files.forEach((file) => {
      const parsed = splitFrontmatter(file.content);
      const items = Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : [];
      items.forEach((tag) => map.set(tag, (map.get(tag) ?? 0) + 1));
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Folders</h3>
        <button
          className="rounded-md p-1 hover:bg-slate-100"
          onClick={async () => {
            if (!workspace) return;
            const name = await dialog.prompt('Create folder', '', 'Folder name');
            if (!name) return;
            const parent = folders.find((f) => f.id === selectedFolderId) ?? null;
            const duplicate = folders.some((f) => f.path === `${parent?.path ? `${parent.path}/` : ''}${name}`);
            if (duplicate) return dialog.alert('Duplicate folder', 'Folder already exists.');
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
                  const name = await dialog.prompt('Rename folder', folder.name, 'New folder name');
                  if (!name) return;
                  const newPath = folder.parent_id ? `${folders.find((f) => f.id === folder.parent_id)?.path}/${name}` : name;
                  const { error } = await supabase.from('folders').update({ name, path: newPath, updated_at: new Date().toISOString() }).eq('id', folder.id);
                  if (error) return dialog.alert('Rename failed', error.message);
                  await refresh();
                }}><Pencil size={14} /></button>
                <button
                  className="rounded p-1 text-slate-500 hover:bg-slate-100"
                  onClick={async () => {
                    if (files.some((f) => f.folder_id === folder.id)) return dialog.alert('Folder not empty', 'Delete files in this folder first.');
                    if (!(await dialog.confirm('Delete folder', `Delete folder ${folder.name}?`))) return;
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

      <div className="mt-auto border-t border-slate-200 p-2">
        <button
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50"
          onClick={async () => {
            if (!workspace) return;
            if (files.length === 0) {
              await dialog.alert('Nothing to export', 'Create at least one prompt file before exporting.');
              return;
            }
            await exportWorkspaceMarkdownZip(workspace, files);
          }}
        >
          <Download size={16} /> Export All
        </button>
      </div>

      <div className="border-t border-slate-200 p-2">
        <h4 className="mb-2 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><Tag size={12} />Tags</h4>
        <button
          className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-sm ${selectedTag === null ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
          onClick={() => selectTag(null)}
        >
          All tags
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
      </div>

    </div>
  );
}
