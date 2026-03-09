import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FrontmatterModel } from '../../types/models';

type Props = {
  frontmatter: FrontmatterModel;
  onChange: (f: FrontmatterModel) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  showMetadata: boolean;
  onShowMetadataChange: (show: boolean) => void;
};

export function MetadataPanel({ frontmatter, onChange, collapsed, onToggleCollapsed, showMetadata, onShowMetadataChange }: Props) {
  const [tagsInput, setTagsInput] = useState((frontmatter.tags ?? []).join(', '));

  useEffect(() => {
    setTagsInput((frontmatter.tags ?? []).join(', '));
  }, [frontmatter.tags]);

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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Metadata</h3>
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
        <label className="block text-xs text-slate-500">Tags (comma separated)
          <input
            className="input mt-1"
            value={tagsInput}
            onChange={(e) => {
              const next = e.target.value;
              setTagsInput(next);
              onChange({ ...frontmatter, tags: next.split(',').map((x) => x.trim()).filter(Boolean) });
            }}
            onBlur={() => setTagsInput((frontmatter.tags ?? []).join(', '))}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-slate-500">Template
            <select
              className="input mt-1"
              value={frontmatter.template ? 'yes' : 'no'}
              onChange={(e) => onChange({ ...frontmatter, template: e.target.value === 'yes' })}
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </label>
          <label className="block text-xs text-slate-500">Starred
            <select
              className="input mt-1"
              value={frontmatter.starred ? 'yes' : 'no'}
              onChange={(e) => onChange({ ...frontmatter, starred: e.target.value === 'yes' })}
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </label>
        </div>
        <label className="block text-xs text-slate-500">Show metadata
          <select className="input mt-1" value={showMetadata ? 'yes' : 'no'} onChange={(e) => onShowMetadataChange(e.target.value === 'yes')}>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </label>
      </div>
    </aside>
  );
}
