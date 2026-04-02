import { markdown } from '@codemirror/lang-markdown';
import type { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { Copy, Download, List, ListOrdered, ListTodo, Minus, Save, Share2, Smile, Table } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MarkdownPreview } from '../../components/MarkdownPreview';
import { usePromptStore } from '../../hooks/usePromptStore';
import { buildCanonicalStockFileName } from '../../hooks/usePromptStore';
import { composeMarkdown, splitFrontmatter } from '../../lib/frontmatter';
import { listNewResearchTasks, updateFile } from '../../lib/dataApi';
import type { FrontmatterModel, NewResearchTask } from '../../types/models';
import { MetadataPanel } from '../metadata/MetadataPanel';
import { useDialog } from '../../components/ui/DialogProvider';

const EMOJIS = ['🔥', '✅', '📌', '🧠', '🚀', '💡', '⚠️', '📊', '🎯', '📝', '🤖', '🔍', '📣', '🧩', '💬', '✨'];

export function EditorPane() {
  const { files, selectedFileId, refresh, noteTypes, sectors, metadataPanelCollapsed, setMetadataPanelCollapsed, transitionTaskModal, editorTab, setEditorTab } = usePromptStore();
  const navigate = useNavigate();
  const dialog = useDialog();
  const file = files.find((f) => f.id === selectedFileId);
  const viewRef = useRef<EditorView | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [selectedEmoji, setSelectedEmoji] = useState<string>('🔥');
  const [showMetadata, setShowMetadata] = useState(false);
  const [linkedTask, setLinkedTask] = useState<NewResearchTask | null>(null);
  const parsed = useMemo(() => splitFrontmatter(file?.content ?? ''), [file?.content]);
  const [body, setBody] = useState(parsed.body);
  const [frontmatter, setFrontmatter] = useState<FrontmatterModel>(parsed.frontmatter);

  useEffect(() => {
    setBody(parsed.body);
    setFrontmatter(parsed.frontmatter);
  }, [file?.id, parsed.body, parsed.frontmatter]);

  useEffect(() => {
    if (!selectedFileId) {
      setLinkedTask(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const tasks = await listNewResearchTasks();
        if (cancelled) return;
        setLinkedTask(tasks.find((task) => task.linked_note_file_id === selectedFileId) ?? null);
      } catch {
        if (!cancelled) setLinkedTask(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedFileId]);

  const metadataSyntax = useMemo(() => {
    const withFrontmatterOnly = composeMarkdown(frontmatter, '');
    const match = withFrontmatterOnly.match(/^---\n([\s\S]*?)\n---\n?$/);
    return match ? match[1] : '';
  }, [frontmatter]);


  if (!file) return <div className="flex h-full items-center justify-center text-slate-400">Select a note to view</div>;

  const merged = composeMarkdown(frontmatter, body);
  const editorValue = showMetadata ? merged : body;
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

  const insertAndMoveCaretRight = (replacement: string) => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: replacement },
      selection: { anchor: sel.from + replacement.length },
      scrollIntoView: true,
    });
    view.focus();
  };

  const toggleWrap = (token: string, fallback: string) => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;

    const transformSegment = (segment: string) => {
      if (token === '*') {
        if (/^\*\*\*[\s\S]+\*\*\*$/.test(segment)) return `**${segment.slice(3, -3)}**`;
        if (/^\*[^*][\s\S]*\*$/.test(segment)) return segment.slice(1, -1);
        if (/^\*\*[\s\S]+\*\*$/.test(segment)) return `***${segment.slice(2, -2)}***`;
        return `*${segment}*`;
      }

      if (/^\*\*\*[\s\S]+\*\*\*$/.test(segment)) return `*${segment.slice(3, -3)}*`;
      if (/^\*\*[\s\S]+\*\*$/.test(segment)) return segment.slice(2, -2);
      if (/^\*[^*][\s\S]*\*$/.test(segment)) return `***${segment.slice(1, -1)}***`;
      return `**${segment}**`;
    };

    if (!sel.empty) {
      const selected = getSelectedText();
      const line = view.state.doc.lineAt(sel.from);
      const isSingleLineSelection = !selected.includes('\n') && sel.from >= line.from && sel.to <= line.to;
      const prefixMatch = isSingleLineSelection
        ? selected.match(/^(#{1,6}\s+|-\s\[[ xX]\]\s+|-\s+|\d+\.\s+)/)
        : null;

      if (prefixMatch) {
        const prefix = prefixMatch[0];
        const remainder = selected.slice(prefix.length);
        const nextRemainder = transformSegment(remainder);
        const next = `${prefix}${nextRemainder}`;
        applySelection(next, 0, next.length);
        return;
      }

      const next = transformSegment(selected);
      applySelection(next, 0, next.length);
      return;
    }

    const line = view.state.doc.lineAt(sel.from);
    const cursorInLine = sel.from - line.from;
    const prefixMatch = line.text.match(/^(#{1,6}\s+|-\s\[[ xX]\]\s+|-\s+|\d+\.\s+)/);
    const contentStart = prefixMatch?.[0].length ?? 0;
    const content = line.text.slice(contentStart);

    let targetStart = -1;
    let targetEnd = -1;
    const wordRegex = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = wordRegex.exec(content)) !== null) {
      const start = contentStart + match.index;
      const end = start + match[0].length;
      if (cursorInLine >= start && cursorInLine <= end) {
        targetStart = start;
        targetEnd = end;
        break;
      }
    }

    if (targetStart < 0) {
      const insert = `${token}${fallback}${token}`;
      applySelection(insert, 0, insert.length);
      return;
    }

    let segmentStart = targetStart;
    while (segmentStart > contentStart && line.text[segmentStart - 1] === '*') {
      segmentStart -= 1;
    }
    let segmentEnd = targetEnd;
    while (segmentEnd < line.text.length && line.text[segmentEnd] === '*') {
      segmentEnd += 1;
    }

    const segment = line.text.slice(segmentStart, segmentEnd);
    const next = transformSegment(segment);
    const from = line.from + segmentStart;
    const to = line.from + segmentEnd;
    const anchorInNext = Math.min(Math.max(0, cursorInLine - segmentStart), next.length);
    view.dispatch({
      changes: { from, to, insert: next },
      selection: { anchor: from + anchorInNext },
      scrollIntoView: true,
    });
    view.focus();
  };

  const toggleHeading = (level: 1 | 2 | 3) => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const sel = view.state.selection.main;
    const startLine = doc.lineAt(sel.from);
    const endLine = doc.lineAt(sel.to);
    const prefix = `${'#'.repeat(level)} `;

    const lines: string[] = [];
    let allAtLevel = true;
    for (let i = startLine.number; i <= endLine.number; i += 1) {
      const t = doc.line(i).text;
      lines.push(t);
      if (!t.startsWith(prefix)) allAtLevel = false;
    }

    const replaced = lines
      .map((line) => {
        const withoutHeading = line.replace(/^#{1,6}\s+/, '');
        return allAtLevel ? withoutHeading : `${prefix}${withoutHeading}`;
      })
      .join('\n');

    const singleCursorOnOneLine = sel.empty && startLine.number === endLine.number;
    const alreadyAtLevel = allAtLevel;
    const existingHeadingPrefix = startLine.text.match(/^#{1,6}\s+/)?.[0] ?? '';
    const shift = alreadyAtLevel ? -existingHeadingPrefix.length : prefix.length - existingHeadingPrefix.length;
    const nextPos = Math.max(startLine.from, sel.from + shift);

    if (singleCursorOnOneLine) {
      view.dispatch({
        changes: { from: startLine.from, to: endLine.to, insert: replaced },
        selection: { anchor: nextPos },
        scrollIntoView: true,
      });
    } else {
      view.dispatch({ changes: { from: startLine.from, to: endLine.to, insert: replaced }, scrollIntoView: true });
    }
    view.focus();
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

    const singleCursorOnOneLine = sel.empty && startLine.number === endLine.number;
    if (singleCursorOnOneLine) {
      const shift = hasAll ? -prefix.length : prefix.length;
      const nextPos = Math.max(startLine.from, sel.from + shift);
      view.dispatch({
        changes: { from: startLine.from, to: endLine.to, insert: replaced },
        selection: { anchor: nextPos },
        scrollIntoView: true,
      });
    } else {
      view.dispatch({ changes: { from: startLine.from, to: endLine.to, insert: replaced }, scrollIntoView: true });
    }
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

    const singleCursorOnOneLine = sel.empty && startLine.number === endLine.number;
    if (singleCursorOnOneLine) {
      const existingPrefix = startLine.text.match(/^\d+\.\s/)?.[0] ?? '';
      const shift = hasAll ? -existingPrefix.length : '1. '.length;
      const nextPos = Math.max(startLine.from, sel.from + shift);
      view.dispatch({
        changes: { from: startLine.from, to: endLine.to, insert: replaced },
        selection: { anchor: nextPos },
        scrollIntoView: true,
      });
    } else {
      view.dispatch({ changes: { from: startLine.from, to: endLine.to, insert: replaced }, scrollIntoView: true });
    }
    view.focus();
  };


  const toggleHorizontalRule = () => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const sel = view.state.selection.main;
    const line = doc.lineAt(sel.from);

    if (line.text.trim() === '---') {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: { anchor: line.from },
        scrollIntoView: true,
      });
      view.focus();
      return;
    }

    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '---' },
      selection: { anchor: line.from + 3 },
      scrollIntoView: true,
    });
    view.focus();
  };

  const currentLine = getLineText();
  const currentSelection = getSelectedText();

  const hasTripleMarkedSelection = currentSelection.startsWith('***') && currentSelection.endsWith('***');

  const active = {
    h1: /^#\s/.test(currentLine),
    h2: /^##\s/.test(currentLine),
    h3: /^###\s/.test(currentLine),
    bold:
      hasTripleMarkedSelection ||
      (currentSelection.startsWith('**') && currentSelection.endsWith('**')) ||
      /\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*/.test(currentLine),
    italic:
      hasTripleMarkedSelection ||
      (currentSelection.startsWith('*') && currentSelection.endsWith('*') && !currentSelection.startsWith('**')) ||
      /\*\*\*[^*]+\*\*\*|(^|\s)\*[^*]+\*(?!\*)/.test(currentLine),
    ol: /^\d+\.\s/.test(currentLine),
    ul: /^-\s/.test(currentLine),
    task: /^-\s\[[ xX]\]\s/.test(currentLine),
    hr: /^\s*---\s*$/.test(currentLine),
  };

  const btn = (on: boolean) => `rounded border px-2 py-1 ${on ? 'border-slate-900 bg-slate-900 text-white' : ''}`;

  const getMarkdownFilename = () => (file.name.toLowerCase().endsWith('.md') ? file.name : `${file.name}.md`);

  const downloadCurrent = () => {
    const blob = new Blob([merged], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = getMarkdownFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const shareCurrent = async () => {
    const filename = getMarkdownFilename();
    const fileObject = new File([merged], filename, { type: 'text/markdown' });

    try {
      if (navigator.share && navigator.canShare?.({ files: [fileObject] })) {
        await navigator.share({ files: [fileObject], title: filename, text: `Sharing ${filename}` });
        return;
      }
    } catch {
      // fall back to mail client workflow below
    }

    const subject = encodeURIComponent(filename);
    const bodyText = encodeURIComponent(`I've attached ${filename}.

${merged}`);
    window.location.href = `mailto:?subject=${subject}&body=${bodyText}`;
  };

  return (
    <div className={`grid h-full grid-cols-1 ${metadataPanelCollapsed ? 'lg:grid-cols-[1fr_48px]' : 'lg:grid-cols-[1fr_300px]'}`}>
      <section className="flex min-h-0 flex-col">
        <div className="border-b border-slate-200 bg-white px-4 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              {([
                { key: 'edit', label: 'Edit' },
                { key: 'split', label: 'Split' },
                { key: 'preview', label: 'Preview' },
              ] as const).map((t) => (
                <button
                  key={t.key}
                  className={`rounded-md px-3 py-1 text-xs ${editorTab === t.key ? 'bg-slate-900 text-white' : 'bg-slate-100'}`}
                  onClick={() => setEditorTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button className="rounded-md border px-2 py-1 text-xs" onClick={downloadCurrent} title="Download" aria-label="Download"><Download className="mr-1 inline" size={14} />Download</button>
              <button className="rounded-md border px-2 py-1 text-xs" onClick={shareCurrent} title="Share" aria-label="Share"><Share2 className="mr-1 inline" size={14} />Share</button>
              <button className="rounded-md border px-2 py-1 text-xs" onClick={() => navigator.clipboard.writeText(merged)}><Copy className="mr-1 inline" size={14} />Copy</button>
              <button
                className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-50"
                disabled={!dirty}
                onClick={async () => {
                  const { error } = await updateFile(file.id, {
                    content: merged,
                    frontmatter_json: frontmatter,
                    is_template: !!frontmatter.template,
                  });
                  if (error) {
                    await dialog.alert('Save failed', error.message);
                    return;
                  }
                  await refresh();
                }}
              >
                <Save className="mr-1 inline" size={14} />Save {dirty ? '*' : ''}
              </button>
            </div>
          </div>
          {editorTab !== 'preview' && (
            <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-slate-100 pt-2 text-xs">
            <button className={btn(active.h1)} onClick={() => toggleHeading(1)}>H1</button>
            <button className={btn(active.h2)} onClick={() => toggleHeading(2)}>H2</button>
            <button className={btn(active.h3)} onClick={() => toggleHeading(3)}>H3</button>
            <button className={btn(active.bold)} onClick={() => toggleWrap('**', 'bold text')}><strong>Bold</strong></button>
            <button className={btn(active.italic)} onClick={() => toggleWrap('*', 'italic text')}><em>Italic</em></button>
            <button className={btn(active.ul)} onClick={() => toggleLinePrefix('- ')}><List size={14} /></button>
            <button className={btn(active.ol)} onClick={toggleOrderedList}><ListOrdered size={14} /></button>
            <button className={btn(active.task)} onClick={() => toggleLinePrefix('- [ ] ')}><ListTodo size={14} /></button>
            <button className={btn(active.hr)} onClick={toggleHorizontalRule}><Minus size={14} /></button>
            <button
              className="rounded border px-2 py-1"
              title="Table"
              aria-label="Table"
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
                insertAndMoveCaretRight(`${header}\n${sep}\n${bodyRows}`);
              }}
            >
              <Table className="inline" size={12} />
            </button>
            <button className="rounded border px-2 py-1" onClick={() => setEmojiOpen(true)} title="Emoji" aria-label="Emoji"><Smile className="inline" size={12} /></button>
            </div>
          )}
        </div>

        <div className={`grid min-h-0 flex-1 ${editorTab === 'split' ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
          {(editorTab === 'edit' || editorTab === 'split') && (
            <CodeMirror
              value={editorValue}
              className="min-h-0 flex-1 overflow-auto"
              height="100%"
              extensions={[markdown({ extensions: [{ remove: ['SetextHeading'] }] })]}
              onCreateEditor={(view) => {
                viewRef.current = view;
              }}
              onChange={(v) => {
                if (showMetadata) {
                  const nextParsed = splitFrontmatter(v);
                  setFrontmatter(nextParsed.frontmatter);
                  setBody(nextParsed.body);
                  return;
                }
                setBody(v);
              }}
            />
          )}
          {(editorTab === 'preview' || editorTab === 'split') && (
            <div className="markdown-preview max-w-none overflow-y-auto border-l border-slate-200 bg-white px-5 pb-5 pt-2 text-sm">
              {showMetadata && metadataSyntax && (
                <pre className="mb-3 overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-600">
                  {metadataSyntax}
                </pre>
              )}
              <MarkdownPreview content={body} />
            </div>
          )}
        </div>
      </section>
      <MetadataPanel
        frontmatter={frontmatter}
        noteTypes={noteTypes}
        sectors={sectors}
        onChange={setFrontmatter}
        onIdentityBlur={async ({ date, ticker, type }) => {
          const nextDate = date.trim();
          const nextTicker = ticker.trim().toUpperCase();
          const nextType = type.trim();
          if (!nextDate || !nextTicker || !nextType) return;
          const nextName = buildCanonicalStockFileName(nextDate, nextTicker, nextType);
          if (nextName === file.name) return;
          const folderPath = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
          const nextPath = folderPath ? `${folderPath}/${nextName}` : nextName;
          const { error } = await updateFile(file.id, { name: nextName, path: nextPath });
          if (!error) {
            await refresh();
          }
        }}
        collapsed={metadataPanelCollapsed}
        onToggleCollapsed={() => setMetadataPanelCollapsed(!metadataPanelCollapsed)}
        showMetadata={showMetadata}
        onShowMetadataChange={setShowMetadata}
        canViewTask={linkedTask !== null}
        onViewTask={() => {
          if (!linkedTask) return;
          transitionTaskModal(linkedTask.id);
          navigate('/tasks.html');
        }}
        viewTaskHelperText={linkedTask ? `Linked to task: ${linkedTask.topic || linkedTask.ticker || linkedTask.id}` : 'No linked task for this note.'}
      />

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
                  onDoubleClick={() => {
                    setSelectedEmoji(emoji);
                    insertAndMoveCaretRight(emoji);
                    setEmojiOpen(false);
                  }}
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
                  insertAndMoveCaretRight(selectedEmoji);
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
