import { useEffect, useMemo, useState } from 'react';
import { AppShell } from './components/AppShell';
import { AuthGate } from './features/auth/AuthGate';
import { FolderTree } from './features/folders/FolderTree';
import { FileList } from './features/files/FileList';
import { EditorPane } from './features/editor/EditorPane';
import { TemplateModal } from './features/templates/TemplateModal';
import { usePromptStore } from './hooks/usePromptStore';
import { updateFile } from './lib/dataApi';

export function App() {
  const { bootstrap, loading, error, selectedFileId, files, refresh } = usePromptStore();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [fileModal, setFileModal] = useState(false);
  const [snippetModal, setSnippetModal] = useState(false);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const current = useMemo(() => files.find((f) => f.id === selectedFileId), [files, selectedFileId]);

  return (
    <AuthGate>
      {loading && <div className="fixed right-4 top-4 rounded bg-slate-900 px-3 py-1 text-xs text-white">Loading…</div>}
      {error && <div className="fixed left-4 top-4 rounded bg-rose-600 px-3 py-1 text-xs text-white">{error}</div>}
      <AppShell
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
        headerRight={<span className="text-xs text-slate-500">Synced Markdown workspace</span>}
        sidebar={<FolderTree />}
        fileList={<FileList openTemplatePicker={() => setFileModal(true)} />}
        main={
          <div className="h-full">
            <div className="border-b border-slate-200 bg-white p-2 md:hidden">
              <FileList openTemplatePicker={() => setFileModal(true)} />
            </div>
            <div className="h-[calc(100%-1px)]">
              <EditorPane openSnippetPicker={() => setSnippetModal(true)} />
            </div>
          </div>
        }
      />
      <TemplateModal mode="file" open={fileModal} onClose={() => setFileModal(false)} onInsertSnippet={() => undefined} />
      <TemplateModal
        mode="snippet"
        open={snippetModal}
        onClose={() => setSnippetModal(false)}
        onInsertSnippet={async (snippet) => {
          if (!current) return;
          await updateFile(current.id, { content: `${current.content}\n\n${snippet}` });
          await refresh();
          setSnippetModal(false);
        }}
      />
    </AuthGate>
  );
}
