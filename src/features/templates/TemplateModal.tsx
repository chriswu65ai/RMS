import { FilePlus2 } from 'lucide-react';
import { MarkdownPreview } from '../../components/MarkdownPreview';
import { useMemo, useState } from 'react';
import { usePromptStore } from '../../hooks/usePromptStore';
import { createFile } from '../../lib/dataApi';
import { composeMarkdown, splitFrontmatter } from '../../lib/frontmatter';
import { useDialog } from '../../components/ui/DialogProvider';

const EMPTY_FILE_NAME_ERROR = 'Cannot create file without a name';

export function TemplateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { files, workspace, selectedFolderId, folders, refresh } = usePromptStore();
  const dialog = useDialog();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const templates = useMemo(
    () =>
      files.filter((f) => {
        const fm = splitFrontmatter(f.content).frontmatter;
        if (fm.template !== true) return false;

        const q = search.toLowerCase();
        return !search || f.name.toLowerCase().includes(q) || f.content.toLowerCase().includes(q);
      }),
    [files, search],
  );
  const selected = templates.find((t) => t.id === selectedId) ?? templates[0];
  const selectedBody = selected ? splitFrontmatter(selected.content).body : 'No template selected.';
  const ensureMdExtension = (name: string) => (name.toLowerCase().endsWith('.md') ? name : `${name}.md`);
  const hasDuplicateInFolder = (folderId: string | null, fileName: string) => {
    const normalizedName = fileName.toLowerCase();
    return files.some((file) => file.folder_id === folderId && file.name.toLowerCase() === normalizedName);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-slate-900/30 p-0 md:items-center md:p-6">
      <div className="grid h-[85vh] w-full max-w-4xl grid-cols-1 overflow-hidden rounded-t-2xl bg-white md:h-[70vh] md:grid-cols-[280px_1fr] md:rounded-2xl">
        <div className="border-r border-slate-200 p-3">
          <div className="mb-2 text-sm font-semibold">Templates</div>
          <input className="input mb-2" placeholder="Search templates" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="space-y-1 overflow-y-auto">
            {templates.map((t) => (
              <button key={t.id} className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${selected?.id === t.id ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`} onClick={() => setSelectedId(t.id)}>{t.name}</button>
            ))}
          </div>
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
            <h4 className="text-sm font-semibold">Preview</h4>
            <button onClick={onClose} className="text-sm text-slate-500">Close</button>
          </div>
          <div className="markdown-preview max-w-none flex-1 overflow-y-auto bg-white px-5 pb-5 pt-2 text-sm">
            <MarkdownPreview content={selectedBody} />
          </div>
          <div className="flex justify-center border-t border-slate-200 p-3">
            <button
              className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
              disabled={!selected}
              onClick={async () => {
                if (!selected || !workspace) return;
                const name = await dialog.prompt(
                  'Create from template',
                  '',
                  'File name (.md extension will be added)',
                  { validate: (value) => (value.trim() ? null : EMPTY_FILE_NAME_ERROR) },
                );
                if (!name) return;
                const fileName = ensureMdExtension(name.trim());
                const folder = folders.find((f) => f.id === selectedFolderId) ?? null;
                const parsed = splitFrontmatter(selected.content);
                const duplicate = hasDuplicateInFolder(folder?.id ?? null, fileName);
                if (duplicate) {
                  await dialog.alert('Duplicate file', 'A file cannot be created because a file with the same name already exists in this folder.');
                  return;
                }
                const clonedFrontmatter = { ...parsed.frontmatter, template: false, title: fileName.replace(/\.md$/i, '') };
                const clonedContent = composeMarkdown(clonedFrontmatter, parsed.body);
                const { error } = await createFile({
                  workspaceId: workspace.id,
                  folderId: folder?.id ?? null,
                  folderPath: folder?.path ?? null,
                  name: fileName,
                  content: clonedContent,
                  isTemplate: false,
                  frontmatter: clonedFrontmatter,
                });
                if (error) return dialog.alert('Create failed', error.message);
                await refresh();
                onClose();
              }}
            ><FilePlus2 size={14} />Create file from template</button>
          </div>
        </div>
      </div>
    </div>
  );
}
