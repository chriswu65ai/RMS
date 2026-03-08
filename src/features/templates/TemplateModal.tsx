import ReactMarkdown from 'react-markdown';
import { useMemo, useState } from 'react';
import { usePromptStore } from '../../hooks/usePromptStore';
import { createFile } from '../../lib/dataApi';

type Mode = 'file' | 'snippet';

export function TemplateModal({ mode, open, onClose, onInsertSnippet }: { mode: Mode; open: boolean; onClose: () => void; onInsertSnippet: (content: string) => void }) {
  const { files, workspace, selectedFolderId, folders, refresh } = usePromptStore();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const templates = useMemo(
    () => files.filter((f) => f.is_template && f.template_type === mode && (f.name.toLowerCase().includes(search.toLowerCase()) || f.content.toLowerCase().includes(search.toLowerCase()))),
    [files, mode, search],
  );
  const selected = templates.find((t) => t.id === selectedId) ?? templates[0];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-slate-900/30 p-0 md:items-center md:p-6">
      <div className="grid h-[85vh] w-full max-w-4xl grid-cols-1 overflow-hidden rounded-t-2xl bg-white md:h-[70vh] md:grid-cols-[280px_1fr] md:rounded-2xl">
        <div className="border-r border-slate-200 p-3">
          <div className="mb-2 text-sm font-semibold">{mode === 'file' ? 'File templates' : 'Snippet templates'}</div>
          <input className="input mb-2" placeholder="Search templates" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="space-y-1 overflow-y-auto">
            {templates.map((t) => (
              <button key={t.id} className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${selected?.id === t.id ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`} onClick={() => setSelectedId(t.id)}>{t.name}</button>
            ))}
          </div>
        </div>
        <div className="flex flex-col">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
            <h4 className="text-sm font-semibold">Preview</h4>
            <button onClick={onClose} className="text-sm text-slate-500">Close</button>
          </div>
          <div className="prose max-w-none flex-1 overflow-y-auto p-4">
            <ReactMarkdown>{selected?.content ?? 'No template selected.'}</ReactMarkdown>
          </div>
          <div className="border-t border-slate-200 p-3">
            {mode === 'file' ? (
              <button
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white"
                disabled={!selected}
                onClick={async () => {
                  if (!selected || !workspace) return;
                  const name = window.prompt('New file name', `from-template-${Date.now()}.md`);
                  if (!name) return;
                  const folder = folders.find((f) => f.id === selectedFolderId) ?? null;
                  await createFile({ workspaceId: workspace.id, folderId: folder?.id ?? null, folderPath: folder?.path ?? null, name, content: selected.content });
                  await refresh();
                  onClose();
                }}
              >Create file from template</button>
            ) : (
              <button className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white" disabled={!selected} onClick={() => selected && onInsertSnippet(selected.content)}>Insert snippet</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
