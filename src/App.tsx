import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { RecommendationBadge } from './components/shared/RecommendationBadge';
import { PageState } from './components/shared/PageState';
import { FolderTree } from './features/folders/FolderTree';
import { FileList } from './features/files/FileList';
import { EditorPane } from './features/editor/EditorPane';
import { TemplateModal } from './features/templates/TemplateModal';
import { useResearchStore } from './hooks/useResearchStore';
import { fileToNoteModel, splitFrontmatter } from './lib/frontmatter';
import { NewResearchBoard } from './features/newResearch/NewResearchBoard';
import { SettingsPage } from './features/settings/SettingsPage';
import { AgentPage } from './features/agent/AgentPage';
import { listNewResearchTasks } from './lib/dataApi';
import { Recommendation, type NewResearchTask, type Note } from './types/models';

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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
};

function TopNavigation() {
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`;

  return (
    <div className="flex items-center justify-between py-2">
      <nav className="flex items-center gap-2">
        <NavLink className={navClass} to="/home">Home</NavLink>
        <NavLink className={navClass} to="/tasks.html">Tasks</NavLink>
        <NavLink className={navClass} to="/research.html">Research</NavLink>
        <NavLink className={navClass} to="/agent">Agent</NavLink>
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
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [fileModal, setFileModal] = useState(false);
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

  const globalResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return files
      .filter((file) => !file.is_template)
      .map((file) => {
        const parsed = splitFrontmatter(file.content).frontmatter;
        const ticker = parsed.ticker?.toString().trim().toLowerCase() ?? '';
        const title = parsed.title?.toString().trim().toLowerCase() ?? '';
        const fileName = file.name.toLowerCase();
        const content = file.content.toLowerCase();
        let score = 0;
        if (ticker === q) score += 150;
        else if (ticker.includes(q)) score += 90;
        if (title === q) score += 120;
        else if (title.includes(q)) score += 80;
        if (fileName.includes(q)) score += 30;
        if (content.includes(q)) score += 10;
        return { file, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((item) => item.file);
  }, [files, search]);

  return (
    <>
      {loading && <div className="fixed right-4 top-4 rounded bg-slate-900 px-3 py-1 text-xs text-white">Loading…</div>}
      {error && <div className="fixed left-4 top-4 rounded bg-rose-600 px-3 py-1 text-xs text-white">{error}</div>}
      <AppShell
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
        topNav={<TopNavigation />}
        headerRight={<div className="relative ml-auto flex w-full max-w-xl items-center gap-2 md:w-1/3"><input className="input h-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" />{search && <span className="text-xs text-slate-500">{globalResults.length}</span>}{search.trim() && <div className="absolute left-0 right-0 top-11 z-20 max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg">{globalResults.length === 0 && <PageState kind="empty" message="No matches found" />}{globalResults.map((file) => { const parsed = splitFrontmatter(file.content); const ticker = parsed.frontmatter.ticker?.toString().toUpperCase(); return <button key={file.id} className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-slate-100" onClick={() => { transitionFromSearchResult(file.id); navigate('/research.html'); }}><span className="font-medium">{ticker ? `${ticker} · ` : ''}{parsed.frontmatter.title?.toString() || file.name}</span><span className="mt-0.5 block text-xs text-slate-500">{file.path}</span></button>; })}</div>}</div>}
        main={<Routes><Route path="/" element={<Navigate to={`/${lastView}.html`} replace />} /><Route path="/home" element={<OverviewPage />} /><Route path="/tasks.html" element={<NewResearchPage />} /><Route path="/research.html" element={<StockResearchPage openTemplatePicker={() => setFileModal(true)} folderPanelCollapsed={stockFoldersCollapsed} setFolderPanelCollapsed={setStockFoldersCollapsed} />} /><Route path="/agent" element={<AgentPage />} /><Route path="/settings" element={<SettingsPage />} /></Routes>}
      />
      <TemplateModal open={fileModal} onClose={() => setFileModal(false)} />
    </>
  );
}
