import { BadgeInfo, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FrontmatterModel } from '../../types/models';

type Props = {
  frontmatter: FrontmatterModel;
  noteTypes: string[];
  sectors: string[];
  onChange: (f: FrontmatterModel) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  showMetadata: boolean;
  onShowMetadataChange: (show: boolean) => void;
  onIdentityBlur: (fields: { date: string; ticker: string; type: string }) => void;
  onViewTask: () => void;
  canViewTask: boolean;
  viewTaskHelperText?: string;
};

const RECOMMENDATIONS: Array<{ value: '' | 'buy' | 'hold' | 'sell' | 'avoid'; label: string }> = [
  { value: '', label: '—' },
  { value: 'buy', label: 'Buy' },
  { value: 'hold', label: 'Hold' },
  { value: 'sell', label: 'Sell' },
  { value: 'avoid', label: 'Avoid' },
];

export function MetadataPanel({
  frontmatter,
  noteTypes,
  sectors,
  onChange,
  collapsed,
  onToggleCollapsed,
  showMetadata,
  onShowMetadataChange,
  onIdentityBlur,
  onViewTask,
  canViewTask,
  viewTaskHelperText,
}: Props) {
  const [selectedSector, setSelectedSector] = useState(frontmatter.sector ?? '');
  const [isBelowLg, setIsBelowLg] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 1023px)').matches : false,
  );

  useEffect(() => {
    setSelectedSector(frontmatter.sector ?? '');
  }, [frontmatter.sector]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(max-width: 1023px)');
    const onChange = (event: MediaQueryListEvent) => setIsBelowLg(event.matches);
    setIsBelowLg(mediaQuery.matches);
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);

  const panelContents = (
    <div className="space-y-3 px-4 pb-4">
      <label className="block text-xs text-slate-500">Date
        <input
          type="date"
          className="input mt-1"
          value={frontmatter.date ?? ''}
          onChange={(e) => onChange({ ...frontmatter, date: e.target.value })}
          onBlur={() => onIdentityBlur({ date: frontmatter.date ?? '', ticker: frontmatter.ticker ?? '', type: frontmatter.type ?? '' })}
        />
      </label>
      <label className="block text-xs text-slate-500">Title
        <input className="input mt-1" value={frontmatter.title ?? ''} onChange={(e) => onChange({ ...frontmatter, title: e.target.value })} />
      </label>
      <label className="block text-xs text-slate-500">Ticker
        <input
          className="input mt-1"
          value={frontmatter.ticker ?? ''}
          onChange={(e) => onChange({ ...frontmatter, ticker: e.target.value.toUpperCase() })}
          onBlur={() => onIdentityBlur({ date: frontmatter.date ?? '', ticker: frontmatter.ticker ?? '', type: frontmatter.type ?? '' })}
        />
      </label>
      <label className="block text-xs text-slate-500">Sector
        <select
          className="input mt-1"
          value={selectedSector}
          onChange={(event) => {
            const sector = event.target.value;
            setSelectedSector(sector);
            onChange({ ...frontmatter, sector });
          }}
        >
          <option value="">—</option>
          {sectors.map((sector) => (
            <option key={sector} value={sector}>{sector}</option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-slate-500">Recommendation
        <select
          className="input mt-1"
          value={frontmatter.recommendation ?? ''}
          onChange={(event) => {
            const recommendation = event.target.value as FrontmatterModel['recommendation'];
            onChange({ ...frontmatter, recommendation });
          }}
        >
          {RECOMMENDATIONS.map((item) => (
            <option key={item.label} value={item.value}>{item.label}</option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-slate-500">Note type
        <select
          className="input mt-1"
          value={frontmatter.type ?? ''}
          onChange={(e) => {
            onChange({ ...frontmatter, type: e.target.value });
            onIdentityBlur({ date: frontmatter.date ?? '', ticker: frontmatter.ticker ?? '', type: e.target.value });
          }}
        >
          <option value="" disabled>Select note type</option>
          {noteTypes.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </label>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
            checked={frontmatter.template === true}
            onChange={(e) => onChange({ ...frontmatter, template: e.target.checked })}
          />
          Template
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
            checked={frontmatter.starred === true}
            onChange={(e) => onChange({ ...frontmatter, starred: e.target.checked })}
          />
          Starred
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
            checked={showMetadata}
            onChange={(e) => onShowMetadataChange(e.target.checked)}
          />
          Show metadata
        </label>
      </div>
      <div className="border-t border-slate-200 pt-3">
        <button
          className={`w-full rounded-md px-3 py-2 text-sm font-medium transition ${canViewTask ? 'bg-slate-900 text-white hover:bg-slate-800' : 'cursor-not-allowed bg-slate-100 text-slate-400'}`}
          type="button"
          onClick={onViewTask}
          disabled={!canViewTask}
        >
          View task
        </button>
        {viewTaskHelperText && <p className="mt-1 text-xs text-slate-500">{viewTaskHelperText}</p>}
      </div>
    </div>
  );

  return (
    <>
      {isBelowLg && (
        <div className="fixed bottom-4 right-4 z-30">
          <button
            className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-lg"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand metadata panel' : 'Collapse metadata panel'}
            title={collapsed ? 'Expand metadata panel' : 'Collapse metadata panel'}
          >
            {collapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
            Metadata
          </button>
        </div>
      )}

      {isBelowLg && !collapsed && (
        <aside className="fixed inset-x-0 bottom-0 z-20 max-h-[70vh] overflow-y-auto rounded-t-xl border-t border-slate-200 bg-white pb-16 shadow-2xl">
          <div className="flex items-center justify-between py-2 pl-3 pr-4">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <BadgeInfo size={12} />
              Metadata
            </h3>
            <button
              className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
              onClick={onToggleCollapsed}
              aria-label="Collapse metadata panel"
              title="Collapse metadata panel"
            >
              <PanelRightClose size={16} />
            </button>
          </div>
          {panelContents}
        </aside>
      )}

      {collapsed ? (
        <aside className="hidden border-l border-slate-200 bg-white lg:block lg:w-12">
          <div className="flex items-center justify-center py-2">
            <button
              className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
              onClick={onToggleCollapsed}
              aria-label="Expand metadata panel"
              title="Expand metadata panel"
            >
              <PanelRightOpen size={16} />
            </button>
          </div>
        </aside>
      ) : (
        <aside className="hidden border-l border-slate-200 bg-white lg:block">
          <div className="flex items-center justify-between py-2 pl-3 pr-4">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <BadgeInfo size={12} />
              Metadata
            </h3>
            <button
              className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
              onClick={onToggleCollapsed}
              aria-label="Collapse metadata panel"
              title="Collapse metadata panel"
            >
              <PanelRightClose size={16} />
            </button>
          </div>
          {panelContents}
        </aside>
      )}
    </>
  );
}
