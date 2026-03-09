import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FrontmatterModel } from '../../types/models';

type Props = {
  frontmatter: FrontmatterModel;
  onChange: (f: FrontmatterModel) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

export function MetadataPanel({ frontmatter, onChange, collapsed, onToggleCollapsed }: Props) {
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
        <h3 className="text-sm font-semibold">Metadata</h3>
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
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!frontmatter.template} onChange={(e) => onChange({ ...frontmatter, template: e.target.checked })} />
          Template
        </label>
      </div>
    </aside>
  );
}
