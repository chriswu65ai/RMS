import { useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { FolderTree } from './features/folders/FolderTree';
import { FileList } from './features/files/FileList';
import { EditorPane } from './features/editor/EditorPane';
import { TemplateModal } from './features/templates/TemplateModal';
import { usePromptStore } from './hooks/usePromptStore';
import { splitFrontmatter } from './lib/frontmatter';
import { NewResearchBoard } from './features/newResearch/NewResearchBoard';

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

type NoteRow = {
  id: string;
  name: string;
  ticker: string;
  sector: string;
  recommendation: 'buy' | 'hold' | 'sell' | 'avoid' | '';
  type: string;
  assignee: string;
  updatedAt: string;
  updatedAtLabel: string;
};

const recommendationStyles: Record<NonNullable<NoteRow['recommendation']>, string> = {
  buy: 'bg-green-100 text-green-800',
  hold: 'bg-yellow-100 text-yellow-800',
  sell: 'bg-rose-100 text-rose-800',
  avoid: 'bg-slate-200 text-slate-700',
  '': 'bg-slate-100 text-slate-500',
};

function OverviewPage() {
  const navigate = useNavigate();
  const { files, selectFile } = usePromptStore();
  const [tickerFilter, setTickerFilter] = useState('');
  const [sectorFilter, setSectorFilter] = useState('');
  const [recommendationFilter, setRecommendationFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');

  const rows = useMemo<NoteRow[]>(() => files
    .filter((file) => !file.is_template)
    .map((file) => {
      const { frontmatter } = splitFrontmatter(file.content);
      const recommendation = (frontmatter.recommendation ?? frontmatter.stock_recommendation ?? '').toString().toLowerCase() as NoteRow['recommendation'];
      const sectors = Array.isArray(frontmatter.sectors) ? frontmatter.sectors.map((item) => String(item).trim()).filter(Boolean) : [];
      const assignee = (frontmatter as Record<string, unknown>).assignee;
      const updatedDate = new Date(file.updated_at);

      return {
        id: file.id,
        name: frontmatter.title?.toString().trim() || file.name,
        ticker: frontmatter.ticker?.toString().trim().toUpperCase() || '—',
        sector: sectors[0] || '—',
        recommendation: ['buy', 'hold', 'sell', 'avoid'].includes(recommendation) ? recommendation : '',
        type: frontmatter.type?.toString().trim() || '—',
        assignee: typeof assignee === 'string' && assignee.trim() ? assignee.trim() : '—',
        updatedAt: file.updated_at,
        updatedAtLabel: Number.isNaN(updatedDate.getTime()) ? file.updated_at : updatedDate.toLocaleString(),
      };
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [files]);

  const options = useMemo(() => ({
    tickers: Array.from(new Set(rows.map((row) => row.ticker).filter((value) => value !== '—'))),
    sectors: Array.from(new Set(rows.map((row) => row.sector).filter((value) => value !== '—'))),
    recommendations: ['buy', 'hold', 'sell', 'avoid'].filter((value) => rows.some((row) => row.recommendation === value)),
    types: Array.from(new Set(rows.map((row) => row.type).filter((value) => value !== '—'))),
    assignees: Array.from(new Set(rows.map((row) => row.assignee).filter((value) => value !== '—'))),
  }), [rows]);

  const filteredRows = useMemo(() => rows.filter((row) => {
    if (tickerFilter && row.ticker !== tickerFilter) return false;
    if (sectorFilter && row.sector !== sectorFilter) return false;
    if (recommendationFilter && row.recommendation !== recommendationFilter) return false;
    if (typeFilter && row.type !== typeFilter) return false;
    if (assigneeFilter && row.assignee !== assigneeFilter) return false;
    return true;
  }), [assigneeFilter, recommendationFilter, rows, sectorFilter, tickerFilter, typeFilter]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="text-lg font-semibold">Overview</h2>
      <p className="mt-2 text-sm text-slate-600">Daily monitoring dashboard for active stock research notes. Click any row to jump directly into Stock Research Part 1 editing.</p>
      <div className="mt-4 grid gap-2 md:grid-cols-5">
        <select className="input" value={tickerFilter} onChange={(e) => setTickerFilter(e.target.value)}>
          <option value="">All tickers</option>
          {options.tickers.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select className="input" value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}>
          <option value="">All sectors</option>
          {options.sectors.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select className="input" value={recommendationFilter} onChange={(e) => setRecommendationFilter(e.target.value)}>
          <option value="">All recommendations</option>
          {options.recommendations.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {options.types.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select className="input" value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
          <option value="">All assignees</option>
          {options.assignees.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Ticker</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Sector</th>
              <th className="px-3 py-2">Recommendation</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Assignee</th>
              <th className="px-3 py-2">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredRows.map((row) => (
              <tr
                key={row.id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => {
                  selectFile(row.id);
                  navigate('/stock-research');
                }}
              >
                <td className="px-3 py-2 font-medium text-slate-900">{row.ticker}</td>
                <td className="px-3 py-2">{row.name}</td>
                <td className="px-3 py-2">{row.sector}</td>
                <td className="px-3 py-2">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${recommendationStyles[row.recommendation]}`}>{row.recommendation || '—'}</span>
                </td>
                <td className="px-3 py-2">{row.type}</td>
                <td className="px-3 py-2">{row.assignee}</td>
                <td className="px-3 py-2 text-slate-500">{row.updatedAtLabel}</td>
              </tr>
            ))}
            {filteredRows.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-slate-500" colSpan={7}>No notes match the selected filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 text-xs text-slate-500">
        Showing {filteredRows.length} of {rows.length} non-template notes (sorted by latest updated first).
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total monitored notes</p>
          <p className="mt-1 text-xl font-semibold">{rows.length}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Visible after filters</p>
          <p className="mt-1 text-xl font-semibold">{filteredRows.length}</p>
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
      <p className="mt-2 text-sm text-slate-600">Track idea-to-completion tasks across Ideas, Researching, and Completed with full SQLite persistence.</p>
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <p><span className="font-medium">Research types:</span> {noteTypes.join(', ')}</p>
        <p className="mt-2"><span className="font-medium">Assignees:</span> {assignees.join(', ')}</p>
      </div>
      <NewResearchBoard assignees={assignees} />
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
  const { bootstrap, loading, error, search, setSearch, files, lastView, setLastView, selectFile } = usePromptStore();
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

  const globalResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return files
      .filter((file) => !file.is_template && (file.name.toLowerCase().includes(q) || file.content.toLowerCase().includes(q)))
      .slice(0, 8);
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
          <div className="relative mx-auto flex w-full max-w-xl items-center gap-2">
            <input className="input h-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search research notes (templates excluded)" />
            {search && <span className="text-xs text-slate-500">{globalResults.length}</span>}
            {search.trim() && (
              <div className="absolute left-0 right-0 top-11 z-20 max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                {globalResults.length === 0 && <p className="px-3 py-2 text-xs text-slate-500">No non-template matches found.</p>}
                {globalResults.map((file) => {
                  const parsed = splitFrontmatter(file.content);
                  const ticker = parsed.frontmatter.ticker?.toString().toUpperCase();
                  return (
                    <button
                      key={file.id}
                      className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-slate-100"
                      onClick={() => {
                        selectFile(file.id);
                        navigate('/stock-research');
                        setSearch('');
                      }}
                    >
                      <span className="font-medium">{ticker ? `${ticker} · ` : ''}{parsed.frontmatter.title?.toString() || file.name}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">{file.path}</span>
                    </button>
                  );
                })}
              </div>
            )}
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
