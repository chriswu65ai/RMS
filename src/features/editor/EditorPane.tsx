import { markdown } from '@codemirror/lang-markdown';
import CodeMirror from '@uiw/react-codemirror';
import { Copy, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { usePromptStore } from '../../hooks/usePromptStore';
import { composeMarkdown, splitFrontmatter } from '../../lib/frontmatter';
import { updateFile } from '../../lib/dataApi';
import type { FrontmatterModel } from '../../types/models';
import { MetadataPanel } from '../metadata/MetadataPanel';

export function EditorPane({ openSnippetPicker }: { openSnippetPicker: () => void }) {
  const { files, selectedFileId, refresh } = usePromptStore();
  const file = files.find((f) => f.id === selectedFileId);
  const [tab, setTab] = useState<'edit' | 'preview' | 'split'>('split');
  const parsed = useMemo(() => splitFrontmatter(file?.content ?? ''), [file?.content]);
  const [body, setBody] = useState(parsed.body);
  const [frontmatter, setFrontmatter] = useState<FrontmatterModel>(parsed.frontmatter);

  useEffect(() => {
    setBody(parsed.body);
    setFrontmatter(parsed.frontmatter);
  }, [file?.id, parsed.body, parsed.frontmatter]);

  if (!file) return <div className="flex h-full items-center justify-center text-slate-400">Select a prompt file.</div>;

  const merged = composeMarkdown(frontmatter, body);
  const dirty = merged !== file.content;

  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[1fr_300px]">
      <section className="flex min-h-0 flex-col">
        <div className="flex flex-wrap items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
          <div className="flex gap-2">
            {(['edit', 'preview', 'split'] as const).map((t) => (
              <button key={t} className={`rounded-md px-3 py-1 text-xs ${tab === t ? 'bg-slate-900 text-white' : 'bg-slate-100'}`} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button className="rounded-md border px-2 py-1 text-xs" onClick={openSnippetPicker}>Insert snippet</button>
            <button className="rounded-md border px-2 py-1 text-xs" onClick={() => navigator.clipboard.writeText(merged)}><Copy className="mr-1 inline" size={14} />Copy</button>
            <button
              className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-50"
              disabled={!dirty}
              onClick={async () => {
                await updateFile(file.id, { content: merged, frontmatter_json: frontmatter });
                await refresh();
              }}
            >
              <Save className="mr-1 inline" size={14} />Save {dirty ? '*' : ''}
            </button>
          </div>
        </div>

        <div className={`grid min-h-0 flex-1 ${tab === 'split' ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
          {(tab === 'edit' || tab === 'split') && (
            <CodeMirror value={body} className="min-h-0 flex-1 overflow-auto" height="100%" extensions={[markdown()]} onChange={(v) => setBody(v)} />
          )}
          {(tab === 'preview' || tab === 'split') && (
            <div className="prose max-w-none overflow-y-auto border-l border-slate-200 bg-white p-5 text-sm">
              <ReactMarkdown>{merged}</ReactMarkdown>
            </div>
          )}
        </div>
      </section>
      <MetadataPanel frontmatter={frontmatter} onChange={setFrontmatter} />
    </div>
  );
}
