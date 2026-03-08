import type { FrontmatterModel } from '../../types/models';

export function MetadataPanel({ frontmatter, onChange }: { frontmatter: FrontmatterModel; onChange: (f: FrontmatterModel) => void }) {
  return (
    <aside className="hidden border-l border-slate-200 bg-white p-4 lg:block">
      <h3 className="mb-4 text-sm font-semibold">Metadata</h3>
      <div className="space-y-3">
        <label className="block text-xs text-slate-500">Title
          <input className="input mt-1" value={frontmatter.title ?? ''} onChange={(e) => onChange({ ...frontmatter, title: e.target.value })} />
        </label>
        <label className="block text-xs text-slate-500">Tags (comma separated)
          <input className="input mt-1" value={(frontmatter.tags ?? []).join(', ')} onChange={(e) => onChange({ ...frontmatter, tags: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!frontmatter.template} onChange={(e) => onChange({ ...frontmatter, template: e.target.checked })} />Template
        </label>
        <label className="block text-xs text-slate-500">Template type
          <select className="input mt-1" value={frontmatter.templateType ?? ''} onChange={(e) => onChange({ ...frontmatter, templateType: (e.target.value || undefined) as 'file' | 'snippet' | undefined })}>
            <option value="">None</option>
            <option value="file">File</option>
            <option value="snippet">Snippet</option>
          </select>
        </label>
      </div>
    </aside>
  );
}
