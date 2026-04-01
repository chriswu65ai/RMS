import { useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { FolderTree } from './features/folders/FolderTree';
import { FileList } from './features/files/FileList';
import { EditorPane } from './features/editor/EditorPane';
import { TemplateModal } from './features/templates/TemplateModal';
import { usePromptStore } from './hooks/usePromptStore';

function LeftNavigation() {
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`;

  return (
    <div className="flex h-full flex-col p-3">
      <nav className="space-y-1">
        <NavLink className={navClass} to="/overview">Overview</NavLink>
        <NavLink className={navClass} to="/new-research">New Research</NavLink>
        <div className="my-3 border-t border-slate-200" />
        <NavLink className={navClass} to="/stock-research">Stock Research</NavLink>
      </nav>
    </div>
  );
}

function OverviewPage() {
  const { selectedTicker, selectedFileId, files } = usePromptStore();
  const current = files.find((file) => file.id === selectedFileId);

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="text-lg font-semibold">Overview</h2>
      <p className="mt-2 text-sm text-slate-600">Shared research context remains active while you switch between Overview, New Research, and Stock Research.</p>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Selected ticker</p>
          <p className="mt-1 text-xl font-semibold">{selectedTicker ?? 'None selected'}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Selected note</p>
          <p className="mt-1 text-sm font-medium text-slate-700">{current?.name ?? 'None selected'}</p>
        </div>
      </div>
    </div>
  );
}

function NewResearchPage() {
  const { assignees, noteTypes } = usePromptStore();
  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="text-lg font-semibold">New Research</h2>
      <p className="mt-2 text-sm text-slate-600">Use this shared scaffold to stage upcoming workflows for Part 2/3 while keeping settings-backed lists available.</p>
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <p><span className="font-medium">Research types:</span> {noteTypes.join(', ')}</p>
        <p className="mt-2"><span className="font-medium">Assignees:</span> {assignees.join(', ')}</p>
      </div>
    </div>
  );
}

function StockResearchPage({ openTemplatePicker, folderPanelCollapsed, setFolderPanelCollapsed }: { openTemplatePicker: () => void; folderPanelCollapsed: boolean; setFolderPanelCollapsed: (collapsed: boolean) => void }) {
  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="hidden border-r border-slate-200 bg-white lg:block">
        <FolderTree collapsed={folderPanelCollapsed} onToggleCollapsed={() => setFolderPanelCollapsed(!folderPanelCollapsed)} />
      </aside>
      <div className="h-full">
        <div className="border-b border-slate-200 bg-white p-2 lg:hidden">
          <FileList openTemplatePicker={openTemplatePicker} />
        </div>
        <div className="h-[calc(100%-1px)]">
          <EditorPane />
        </div>
      </div>
    </div>
  );
}

export function App() {
  const { bootstrap, loading, error, search, setSearch, files, lastView, setLastView } = usePromptStore();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [fileModal, setFileModal] = useState(false);
  const [folderPanelCollapsed, setFolderPanelCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (location.pathname === '/') {
      navigate(`/${lastView}`, { replace: true });
      return;
    }

    if (location.pathname.startsWith('/overview')) setLastView('overview');
    if (location.pathname.startsWith('/new-research')) setLastView('new-research');
    if (location.pathname.startsWith('/stock-research')) setLastView('stock-research');
  }, [lastView, location.pathname, navigate, setLastView]);

  const globalResultsCount = useMemo(() => {
    if (!search.trim()) return 0;
    const q = search.toLowerCase();
    return files.filter((file) => !file.is_template && (file.name.toLowerCase().includes(q) || file.content.toLowerCase().includes(q))).length;
  }, [files, search]);

  const showStockRightPanel = location.pathname.startsWith('/stock-research');

  return (
    <>
      {loading && <div className="fixed right-4 top-4 rounded bg-slate-900 px-3 py-1 text-xs text-white">Loading…</div>}
      {error && <div className="fixed left-4 top-4 rounded bg-rose-600 px-3 py-1 text-xs text-white">{error}</div>}
      <AppShell
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
        leftNav={<LeftNavigation />}
        headerRight={
          <div className="mx-auto flex max-w-xl items-center gap-2">
            <input className="input h-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search research notes (templates excluded)" />
            {search && <span className="text-xs text-slate-500">{globalResultsCount}</span>}
          </div>
        }
        rightPanel={showStockRightPanel ? <FileList openTemplatePicker={() => setFileModal(true)} /> : undefined}
        main={
          <Routes>
            <Route path="/" element={<Navigate to={`/${lastView}`} replace />} />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/new-research" element={<NewResearchPage />} />
            <Route path="/stock-research" element={<StockResearchPage openTemplatePicker={() => setFileModal(true)} folderPanelCollapsed={folderPanelCollapsed} setFolderPanelCollapsed={setFolderPanelCollapsed} />} />
          </Routes>
        }
      />
      <TemplateModal open={fileModal} onClose={() => setFileModal(false)} />
    </>
  );
}
