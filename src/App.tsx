import { useEffect, useState } from 'react';
import { AppShell } from './components/AppShell';
import { AuthGate } from './features/auth/AuthGate';
import { FolderTree } from './features/folders/FolderTree';
import { FileList } from './features/files/FileList';
import { EditorPane } from './features/editor/EditorPane';
import { TemplateModal } from './features/templates/TemplateModal';
import { usePromptStore } from './hooks/usePromptStore';
import { getSupabaseSetupState } from './lib/supabase';
import { SetupWizard } from './features/auth/SetupWizard';

export function App() {
  const { bootstrap, loading, error } = usePromptStore();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [fileModal, setFileModal] = useState(false);
  const [folderPanelCollapsed, setFolderPanelCollapsed] = useState(false);
  const [setupVersion, setSetupVersion] = useState(0);

  const setupState = getSupabaseSetupState();

  useEffect(() => {
    if (setupState.status !== 'ready') return;
    bootstrap();
  }, [bootstrap, setupState.status, setupVersion]);

  if (setupState.status !== 'ready') {
    return <SetupWizard onReady={() => setSetupVersion((v) => v + 1)} />;
  }

  return (
    <AuthGate>
      {loading && <div className="fixed right-4 top-4 rounded bg-slate-900 px-3 py-1 text-xs text-white">Loading…</div>}
      {error && <div className="fixed left-4 top-4 rounded bg-rose-600 px-3 py-1 text-xs text-white">{error}</div>}
      <AppShell
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
        sidebarCollapsed={folderPanelCollapsed}
        headerRight={<span className="text-xs text-slate-500">Synced Markdown workspace</span>}
        sidebar={<FolderTree collapsed={folderPanelCollapsed} onToggleCollapsed={() => setFolderPanelCollapsed((prev) => !prev)} />}
        fileList={<FileList openTemplatePicker={() => setFileModal(true)} />}
        main={
          <div className="h-full">
            <div className="border-b border-slate-200 bg-white p-2 md:hidden">
              <FileList openTemplatePicker={() => setFileModal(true)} />
            </div>
            <div className="h-[calc(100%-1px)]">
              <EditorPane />
            </div>
          </div>
        }
      />
      <TemplateModal open={fileModal} onClose={() => setFileModal(false)} />
    </AuthGate>
  );
}
