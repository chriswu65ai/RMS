import { markdown } from '@codemirror/lang-markdown';
import type { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { Copy, Download, Save, Smile } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { usePromptStore } from '../../hooks/usePromptStore';
import { composeMarkdown, splitFrontmatter } from '../../lib/frontmatter';
import { updateFile } from '../../lib/dataApi';
import type { FrontmatterModel } from '../../types/models';
import { MetadataPanel } from '../metadata/MetadataPanel';
import { useDialog } from '../../components/ui/DialogProvider';

const EMOJIS = ['🔥', '✅', '📌', '🧠', '🚀', '💡', '⚠️', '📊', '🎯', '📝', '🤖', '🔍', '📣', '🧩', '💬', '✨'];

export function EditorPane() {
  const { files, selectedFileId, refresh } = usePromptStore();
  const dialog = useDialog();
  const file = files.find((f) => f.id === selectedFileId);
  const viewRef = useRef<EditorView | null>(null);
  const [tab, setTab] = useState<'edit' | 'preview' | 'split'>('split');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [selectedEmoji, setSelectedEmoji] = useState<string>('🔥');
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

  const getLineText = () => {
    const view = viewRef.current;
    if (!view) return '';
    return view.state.doc.lineAt(view.state.selection.main.from).text;
  };

  const getSelectedText = () => {
    const view = viewRef.current;
    if (!view) return '';
    const sel = view.state.selection.main;
    return view.state.doc.sliceString(sel.from, sel.to);
  };

  const applySelection = (replacement: string, startOffset = 0, endOffset = replacement.length) => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: replacement },
      selection: { anchor: sel.from + startOffset, head: sel.from + endOffset },
      scrollIntoView: true,
    });
    view.focus();
  };

  const toggleWrap = (token: string, fallback: string) => {
    const selected = getSelectedText();
    if (!selected) {
      const insert = `${token}${fallback}${token}`;
      applySelection(insert, token.length, token.length + fallback.length);
      return;
    }
    if (selected.startsWith(token) && selected.endsWith(token)) {
      const unwrapped = selected.slice(token.length, selected.length - token.length);
      applySelection(unwrapped, 0, unwrapped.length);
      return;
    }
    const wrapped = `${token}${selected}${token}`;
    applySelection(wrapped, token.length, token.length + selected.length);
  };

  const toggleLinePrefix = (prefix: string) => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const sel = view.state.selection.main;
    const startLine = doc.lineAt(sel.from);
    const endLine = doc.lineAt(sel.to);
    const lines: string[] = [];
    let hasAll = true;
    for (let i = startLine.number; i <= endLine.number; i += 1) {
      const t = doc.line(i).text;
      lines.push(t);
      if (!t.startsWith(prefix)) hasAll = false;
    }
    const replaced = lines.map((line) => (hasAll ? line.replace(prefix, '') : `${prefix}${line}`)).join('\n');
    view.dispatch({ changes: { from: startLine.from, to: endLine.to, insert: replaced }, scrollIntoView: true });
    view.focus();
  };

  const toggleOrderedList = () => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const sel = view.state.selection.main;
    const startLine = doc.lineAt(sel.from);
    const endLine = doc.lineAt(sel.to);
    const lines: string[] = [];
    let hasAll = true;
    for (let i = startLine.number; i <= endLine.number; i += 1) {
      const t = doc.line(i).text;
      lines.push(t);
      if (!/^\d+\.\s/.test(t)) hasAll = false;
    }
    const replaced = lines
      .map((line, i) => (hasAll ? line.replace(/^\d+\.\s/, '') : `${i + 1}. ${line}`))
      .join('\n');
    view.dispatch({ changes: { from: startLine.from, to: endLine.to, insert: replaced }, scrollIntoView: true });
    view.focus();
  };

  const currentLine = getLineText();
  const currentSelection = getSelectedText();

  const active = {
    h1: currentLine.startsWith('# '),
    h2: currentLine.startsWith('## '),
    h3: currentLine.startsWith('### '),
    bold: currentSelection.startsWith('**') && currentSelection.endsWith('**') || /\*\*.+\*\*/.test(currentLine),
    italic: currentSelection.startsWith('*') && currentSelection.endsWith('*') && !currentSelection.startsWith('**') || /(^|\s)\*[^*]+\*/.test(currentLine),
    ol: /^\d+\.\s/.test(currentLine),
    ul: /^-\s/.test(currentLine),
    task: /^-\s\[[ xX]\]\s/.test(currentLine),
  };

  const btn = (on: boolean) => `rounded border px-2 py-1 ${on ? 'border-slate-900 bg-slate-900 text-white' : ''}`;

  const downloadCurrent = () => {
    const filename = file.name.toLowerCase().endsWith('.md') ? file.name : `${file.name}.md`;
    const blob = new Blob([merged], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[1fr_300px]">
      <section className="flex min-h-0 flex-col">
        <div className="border-b border-slate-200 bg-white px-4 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              {(['edit', 'preview', 'split'] as const).map((t) => (
                <button key={t} className={`rounded-md px-3 py-1 text-xs ${tab === t ? 'bg-slate-900 text-white' : 'bg-slate-100'}`} onClick={() => setTab(t)}>{t}</button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button className="rounded-md border px-2 py-1 text-xs" onClick={downloadCurrent}><Download className="mr-1 inline" size={14} />Download</button>
              <button className="rounded-md border px-2 py-1 text-xs" onClick={() => navigator.clipboard.writeText(merged)}><Copy className="mr-1 inline" size={14} />Copy</button>
              <button
                className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-50"
                disabled={!dirty}
                onClick={async () => {
                  await updateFile(file.id, {
                    content: merged,
                    frontmatter_json: frontmatter,
                    is_template: !!frontmatter.template,
                    template_type: frontmatter.template ? (frontmatter.templateType ?? null) : null,
                  });
                  await refresh();
                }}
              >
                <Save className="mr-1 inline" size={14} />Save {dirty ? '*' : ''}
              </button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-slate-100 pt-2 text-xs">
            <button className={btn(active.h1)} onClick={() => toggleLinePrefix('# ')}>H1</button>
            <button className={btn(active.h2)} onClick={() => toggleLinePrefix('## ')}>H2</button>
            <button className={btn(active.h3)} onClick={() => toggleLinePrefix('### ')}>H3</button>
            <button className={btn(active.bold)} onClick={() => toggleWrap('**', 'bold text')}>Bold</button>
            <button className={btn(active.italic)} onClick={() => toggleWrap('*', 'italic text')}>Italic</button>
            <button className={btn(active.ol)} onClick={toggleOrderedList}>OL</button>
            <button className={btn(active.ul)} onClick={() => toggleLinePrefix('- ')}>UL</button>
            <button className={btn(active.task)} onClick={() => toggleLinePrefix('- [ ] ')}>Task</button>
            <button
              className="rounded border px-2 py-1"
              onClick={async () => {
                const r = await dialog.prompt('Insert table', '3', 'Rows');
                if (!r) return;
                const c = await dialog.prompt('Insert table', '3', 'Columns');
                if (!c) return;
                const rows = Math.max(1, Number.parseInt(r, 10) || 1);
                const cols = Math.max(1, Number.parseInt(c, 10) || 1);
                const header = `| ${Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ')} |`;
                const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
                const bodyRows = Array.from({ length: rows }, () => `| ${Array.from({ length: cols }, () => ' ').join(' | ')} |`).join('\n');
                applySelection(`${header}\n${sep}\n${bodyRows}`);
              }}
            >
              Table
            </button>
            <button className="rounded border px-2 py-1" onClick={() => setEmojiOpen(true)}><Smile className="mr-1 inline" size={12} />Emoji</button>
          </div>
        </div>

        <div className={`grid min-h-0 flex-1 ${tab === 'split' ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
          {(tab === 'edit' || tab === 'split') && (
            <CodeMirror
              value={body}
              className="min-h-0 flex-1 overflow-auto"
              height="100%"
              extensions={[markdown()]}
              onCreateEditor={(view) => {
                viewRef.current = view;
              }}
              onChange={(v) => setBody(v)}
            />
          )}
          {(tab === 'preview' || tab === 'split') && (
            <div className="prose max-w-none overflow-y-auto border-l border-slate-200 bg-white p-5 text-sm">
              <ReactMarkdown>{merged}</ReactMarkdown>
            </div>
          )}
        </div>
      </section>
      <MetadataPanel frontmatter={frontmatter} onChange={setFrontmatter} />

      {emojiOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <h3 className="text-sm font-semibold">Select emoji</h3>
            <div className="mt-3 grid max-h-64 grid-cols-8 gap-2 overflow-y-auto">
              {EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  className={`rounded-lg border px-2 py-2 text-xl ${selectedEmoji === emoji ? 'border-slate-900 bg-slate-100' : 'border-slate-200'}`}
                  onClick={() => setSelectedEmoji(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded-md border border-slate-300 px-3 py-1.5 text-sm" onClick={() => setEmojiOpen(false)}>Close</button>
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white"
                onClick={() => {
                  applySelection(selectedEmoji);
                  setEmojiOpen(false);
                }}
              >
                Insert
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
