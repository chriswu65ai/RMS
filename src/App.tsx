import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { RecommendationBadge } from './components/shared/RecommendationBadge';
import { PageState } from './components/shared/PageState';
import { ResearchRouteErrorBoundary } from './components/shared/ResearchRouteErrorBoundary';
import { FolderTree } from './features/folders/FolderTree';
import { FileList } from './features/files/FileList';
import { EditorPane } from './features/editor/EditorPane';
import { TemplateModal } from './features/templates/TemplateModal';
import { useResearchStore } from './hooks/useResearchStore';
import { fileToNoteModel, splitFrontmatter } from './lib/frontmatter';
import { NewResearchBoard } from './features/newResearch/NewResearchBoard';
import { ChatPage } from './features/chat/ChatPage';
import { SettingsLayout } from './features/settings/SettingsLayout';
import { SettingsGeneralPage } from './features/settings/SettingsGeneralPage';
import { SettingsAIPage } from './features/settings/SettingsAIPage';
import { SettingsAttachmentsPage } from './features/settings/SettingsAttachmentsPage';
import { SettingsSystemLogPage } from './features/settings/SettingsSystemLogPage';
import { ExpandableSearch } from './components/shared/ExpandableSearch';
import { listNewResearchTasks } from './lib/dataApi';
import { Recommendation, type NewResearchTask, type Note } from './types/models';
import { formatLocalDateTime } from './lib/time';
import { buildGlobalSearchIndex, queryGlobalSearchIndex } from './features/search/globalSearch';

const normalizeSector = (value: string) => value.trim().toLowerCase();
const recommendationLabels: Record<Recommendation, string> = {
  [Recommendation.Buy]: 'Buy',
  [Recommendation.Hold]: 'Hold',
  [Recommendation.Sell]: 'Sell',
  [Recommendation.Avoid]: 'Avoid',
};
const formatRecommendationLabel = (value: Recommendation) => recommendationLabels[value];
const formatCreatedDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
};
const formatUpdatedDate = (value: string) => {
  return formatLocalDateTime(value);
};
const DEFAULT_SETTINGS_SUBPAGE = 'ai';

function TopNavigation() {
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `block shrink-0 rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`;

  return (
    <div className="max-w-full py-2">
      <nav className="scrollbar-hidden flex max-w-full items-center gap-2 overflow-x-auto whitespace-nowrap overscroll-x-contain [scroll-behavior:smooth] [-webkit-overflow-scrolling:touch]">
        <NavLink className={navClass} to="/home">Home</NavLink>
        <NavLink className={navClass} to="/tasks.html">Tasks</NavLink>
        <NavLink className={navClass} to="/research.html">Research</NavLink>
        <NavLink className={navClass} to="/chat">Chat</NavLink>
        <NavLink className={navClass} to="/settings">Settings</NavLink>
      </nav>
    </div>
  );
}

function CenterLayout({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return (
    <div className="h-full overflow-auto px-4 py-6">
      <div className="w-full">
        {title ? <h2 className="text-lg font-semibold">{title}</h2> : null}
        {description ? <p className="mt-2 text-sm text-slate-600">{description}</p> : null}
        {children}
      </div>
    </div>
  );
}

function OverviewPage() {
  const navigate = useNavigate();
  const { files, transitionFromOverviewRow } = useResearchStore();
  const [tasks, setTasks] = useState<NewResearchTask[]>([]);
  const [tickerFilter, setTickerFilter] = useState('');
  const [sectorFilter, setSectorFilter] = useState('');
  const [recommendationFilter, setRecommendationFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [dateSortDirection, setDateSortDirection] = useState<'desc' | 'asc'>('desc');

  useEffect(() => {
    void (async () => {
      try {
        setTasks(await listNewResearchTasks());
      } catch {
        setTasks([]);
      }
    })();
  }, []);

  const taskByLinkedFile = useMemo(() => {
    const byFile = new Map<string, NewResearchTask>();
    tasks.forEach((task) => {
      if (!task.linked_note_file_id) return;
      const existing = byFile.get(task.linked_note_file_id);
      if (!existing || new Date(task.updated_at).getTime() > new Date(existing.updated_at).getTime()) {
        byFile.set(task.linked_note_file_id, task);
      }
    });
    return byFile;
  }, [tasks]);

  const rows = useMemo<Note[]>(() => files
    .filter((file) => !file.is_template)
    .map(fileToNoteModel)
    .map((row) => {
      const linkedTask = taskByLinkedFile.get(row.id);
      return linkedTask ? { ...row, assignee: linkedTask.assignee || row.assignee } : row;
    })
    .sort((a, b) => (
      dateSortDirection === 'desc'
        ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )), [dateSortDirection, files, taskByLinkedFile]);

  const sectorsForRow = (row: Note) => row.stock.sectors.map((sector) => sector.trim()).filter(Boolean);
  const uniqueSectors = (values: string[]) => {
    const byNormalized = new Map<string, string>();
    values.forEach((sector) => {
      const normalized = normalizeSector(sector);
      if (!normalized || byNormalized.has(normalized)) return;
      byNormalized.set(normalized, sector);
    });
    return Array.from(byNormalized.values());
  };

  const options = useMemo(() => ({
    tickers: Array.from(new Set(rows.map((row) => row.stock.ticker).filter((value) => value !== '—'))),
    sectors: uniqueSectors(rows.flatMap((row) => sectorsForRow(row))),
    recommendations: Object.values(Recommendation).filter((value) => rows.some((row) => row.stock.recommendation === value)),
    types: Array.from(new Set(rows.map((row) => row.type).filter((value) => value !== '—'))),
    assignees: Array.from(new Set(rows.map((row) => row.assignee).filter((value) => value !== '—'))),
  }), [rows]);

  const filteredRows = useMemo(() => rows.filter((row) => {
    if (tickerFilter && row.stock.ticker !== tickerFilter) return false;
    if (sectorFilter) {
      const normalizedFilter = normalizeSector(sectorFilter);
      if (!sectorsForRow(row).some((sector) => normalizeSector(sector) === normalizedFilter)) return false;
    }
    if (recommendationFilter && row.stock.recommendation !== recommendationFilter) return false;
    if (typeFilter && row.type !== typeFilter) return false;
    if (assigneeFilter && row.assignee !== assigneeFilter) return false;
    return true;
  }), [assigneeFilter, recommendationFilter, rows, sectorFilter, tickerFilter, typeFilter]);

  return (
    <CenterLayout>
      <div className="mt-4 grid gap-2 md:grid-cols-5">
        <select className="input" value={tickerFilter} onChange={(e) => setTickerFilter(e.target.value)}><option value="">All tickers</option>{options.tickers.map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <select className="input" value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}><option value="">All sectors</option>{options.sectors.map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <select className="input" value={recommendationFilter} onChange={(e) => setRecommendationFilter(e.target.value)}><option value="">All recommendations</option>{options.recommendations.map((value) => <option key={value} value={value}>{formatRecommendationLabel(value)}</option>)}</select>
        <select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}><option value="">All types</option>{options.types.map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <select className="input" value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}><option value="">All assignees</option>{options.assignees.map((value) => <option key={value} value={value}>{value}</option>)}</select>
      </div>
      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="w-32 px-3 py-2">
                <button className="text-xs font-semibold" onClick={() => setDateSortDirection((prev) => prev === 'desc' ? 'asc' : 'desc')}>Date created {dateSortDirection === 'desc' ? '↓' : '↑'}</button>
              </th>
              <th className="w-24 px-3 py-2 text-xs font-semibold">Ticker</th>
              <th className="w-[32rem] px-3 py-2 text-xs font-semibold">Title</th>
              <th className="w-32 px-3 py-2 text-xs font-semibold">Sector</th>
              <th className="w-28 px-3 py-2 text-xs font-semibold">Recommendation</th>
              <th className="w-24 px-3 py-2 text-xs font-semibold">Type</th>
              <th className="w-24 px-3 py-2 text-xs font-semibold">Assignee</th>
              <th className="w-44 px-3 py-2 text-xs font-semibold">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredRows.map((row) => (
              <tr key={row.id} className="cursor-pointer hover:bg-slate-50" onClick={() => { transitionFromOverviewRow(row.id); navigate('/research.html'); }}>
                <td className="px-3 py-2 text-slate-600">{formatCreatedDate(row.createdAt)}</td><td className="px-3 py-2 font-medium text-slate-900">{row.stock.ticker}</td><td className="px-3 py-2">{row.title}</td><td className="px-3 py-2">{sectorsForRow(row).join(', ') || '—'}</td><td className="px-3 py-2"><RecommendationBadge value={row.stock.recommendation} /></td><td className="px-3 py-2">{row.type}</td><td className="px-3 py-2">{row.assignee}</td><td className="px-3 py-2 text-slate-500">{formatUpdatedDate(row.updatedAt)}</td>
              </tr>
            ))}
            {filteredRows.length === 0 && <tr><td className="px-3 py-6" colSpan={8}><PageState kind="empty" message="No research entries match the selected filters." /></td></tr>}
          </tbody>
        </table>
      </div>
    </CenterLayout>
  );
}

function NewResearchPage() {
  const { assignees, noteTypes } = useResearchStore();
  return (
    <CenterLayout>
      <NewResearchBoard assignees={assignees} noteTypes={noteTypes} />
    </CenterLayout>
  );
}

function StockResearchPage({ openTemplatePicker, folderPanelCollapsed, setFolderPanelCollapsed }: { openTemplatePicker: () => void; folderPanelCollapsed: boolean; setFolderPanelCollapsed: (collapsed: boolean) => void }) {
  return (
    <div className={`grid h-full min-h-0 overflow-hidden ${folderPanelCollapsed ? 'grid-cols-[48px_minmax(0,340px)_minmax(0,1fr)]' : 'grid-cols-[260px_minmax(0,340px)_minmax(0,1fr)]'}`}>
      <aside className="min-h-0 border-r border-slate-200 bg-white"><FolderTree collapsed={folderPanelCollapsed} onToggleCollapsed={() => setFolderPanelCollapsed(!folderPanelCollapsed)} /></aside>
      <section className="relative min-h-0 border-r border-slate-200 bg-panel">
        <FileList openTemplatePicker={openTemplatePicker} />
      </section>
      <div className="h-full min-h-0 overflow-hidden"><EditorPane /></div>
    </div>
  );
}

export function App() {
  const { bootstrap, loading, error, search, setSearch, files, lastView, setLastView, transitionFromSearchResult, stockFoldersCollapsed, setStockFoldersCollapsed } = useResearchStore();
  const [fileModal, setFileModal] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  useEffect(() => {
    if (location.pathname === '/') {
      navigate(`/${lastView}.html`, { replace: true });
      return;
    }
    if (location.pathname.startsWith('/home')) setLastView('home');
    if (location.pathname.startsWith('/tasks')) setLastView('tasks');
    if (location.pathname.startsWith('/research')) setLastView('research');
  }, [lastView, location.pathname, navigate, setLastView]);

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedSearch(search), 120);
    return () => clearTimeout(timeoutId);
  }, [search]);

  const globalSearchIndex = useMemo(() => buildGlobalSearchIndex(files), [files]);

  const globalResults = useMemo(() => {
    return queryGlobalSearchIndex(globalSearchIndex, debouncedSearch, 8);
  }, [debouncedSearch, globalSearchIndex]);

  return (
    <>
      {loading && <div className="fixed right-4 top-4 rounded bg-slate-900 px-3 py-1 text-xs text-white">Loading…</div>}
      {error && <div className="fixed left-4 top-4 rounded bg-rose-600 px-3 py-1 text-xs text-white">{error}</div>}
      <AppShell
        topNav={<TopNavigation />}
        headerRight={(
          <ExpandableSearch
            value={search}
            onChange={setSearch}
            placeholder="Search"
            ariaLabel="Search all research notes"
            trailingContent={search ? globalResults.length : null}
          >
            {globalResults.length === 0 && <PageState kind="empty" message="No matches found" />}
            {globalResults.map((file) => {
              const parsed = splitFrontmatter(file.content);
              const ticker = parsed.frontmatter.ticker?.toString().toUpperCase();
              return (
                <button
                  key={file.id}
                  className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-slate-100"
                  onClick={() => {
                    transitionFromSearchResult(file.id);
                    navigate('/research.html');
                  }}
                >
                  <span className="font-medium">{ticker ? `${ticker} · ` : ''}{parsed.frontmatter.title?.toString() || file.name}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{file.path}</span>
                </button>
              );
            })}
          </ExpandableSearch>
        )}
        main={(
          <Routes>
            <Route path="/" element={<Navigate to={`/${lastView}.html`} replace />} />
            <Route path="/home" element={<OverviewPage />} />
            <Route path="/tasks.html" element={<NewResearchPage />} />
            <Route
              path="/research.html"
              element={(
                <ResearchRouteErrorBoundary resetKey={`${location.pathname}:${location.key}`}>
                  <StockResearchPage
                    openTemplatePicker={() => setFileModal(true)}
                    folderPanelCollapsed={stockFoldersCollapsed}
                    setFolderPanelCollapsed={setStockFoldersCollapsed}
                  />
                </ResearchRouteErrorBoundary>
              )}
            />
            <Route path="/agent" element={<Navigate to="/settings/ai" replace />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to={DEFAULT_SETTINGS_SUBPAGE} replace />} />
              <Route path="general" element={<SettingsGeneralPage />} />
              <Route path="ai" element={<SettingsAIPage />} />
              <Route path="attachments" element={<SettingsAttachmentsPage />} />
              <Route path="system-log" element={<SettingsSystemLogPage />} />
              <Route path="*" element={<Navigate to={DEFAULT_SETTINGS_SUBPAGE} replace />} />
            </Route>
          </Routes>
        )}
      />
      <TemplateModal open={fileModal} onClose={() => setFileModal(false)} />
    </>
  );
}
