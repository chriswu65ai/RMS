import { BadgeInfo, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FrontmatterModel } from '../../types/models';

type Props = {
  frontmatter: FrontmatterModel;
  onChange: (f: FrontmatterModel) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  showMetadata: boolean;
  onShowMetadataChange: (show: boolean) => void;
  onIdentityBlur: (fields: { date: string; ticker: string; type: string }) => void;
};

const RECOMMENDATIONS: Array<{ value: '' | 'buy' | 'hold' | 'sell' | 'avoid'; label: string }> = [
  { value: '', label: '—' },
  { value: 'buy', label: 'Buy' },
  { value: 'hold', label: 'Hold' },
  { value: 'sell', label: 'Sell' },
  { value: 'avoid', label: 'Avoid' },
];

export function MetadataPanel({ frontmatter, onChange, collapsed, onToggleCollapsed, showMetadata, onShowMetadataChange, onIdentityBlur }: Props) {
  const [sectorsInput, setSectorsInput] = useState((frontmatter.sectors ?? []).join(', '));

  useEffect(() => {
    setSectorsInput((frontmatter.sectors ?? []).join(', '));
  }, [frontmatter.sectors]);

  if (collapsed) {
    return (
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
    );
  }

  return (
    <aside className="hidden border-l border-slate-200 bg-white lg:block">
      <div className="flex items-center justify-between py-2 pl-3 pr-4">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <BadgeInfo size={12} />
          Stock metadata
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
      <div className="space-y-3 px-4 pb-4">
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
        <label className="block text-xs text-slate-500">Note type
          <input
            className="input mt-1"
            value={frontmatter.type ?? ''}
            onChange={(e) => onChange({ ...frontmatter, type: e.target.value })}
            onBlur={() => onIdentityBlur({ date: frontmatter.date ?? '', ticker: frontmatter.ticker ?? '', type: frontmatter.type ?? '' })}
          />
        </label>
        <label className="block text-xs text-slate-500">Date
          <input
            type="date"
            className="input mt-1"
            value={frontmatter.date ?? ''}
            onChange={(e) => onChange({ ...frontmatter, date: e.target.value })}
            onBlur={() => onIdentityBlur({ date: frontmatter.date ?? '', ticker: frontmatter.ticker ?? '', type: frontmatter.type ?? '' })}
          />
        </label>
        <label className="block text-xs text-slate-500">Sectors (comma separated)
          <input
            className="input mt-1"
            value={sectorsInput}
            onChange={(e) => {
              setSectorsInput(e.target.value);
            }}
            onBlur={() => {
              const nextSectors = sectorsInput.split(',').map((x) => x.trim()).filter(Boolean);
              onChange({ ...frontmatter, sectors: nextSectors });
              setSectorsInput(nextSectors.join(', '));
            }}
          />
        </label>
        <label className="block text-xs text-slate-500">Recommendation
          <select
            className="input mt-1"
            value={frontmatter.recommendation ?? ''}
            onChange={(event) => {
              const recommendation = event.target.value as FrontmatterModel['recommendation'];
              onChange({ ...frontmatter, recommendation, stock_recommendation: recommendation });
            }}
          >
            {RECOMMENDATIONS.map((item) => (
              <option key={item.label} value={item.value}>{item.label}</option>
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
      </div>
    </aside>
  );
}
