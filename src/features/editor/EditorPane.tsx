import { isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import { openSearchPanel } from '@codemirror/search';
import { EditorView, keymap } from '@codemirror/view';
import { editorExtensions, shouldRenderEditableEditor } from './editorSpellcheck';
import CodeMirror from '@uiw/react-codemirror';
import { Copy, Download, Link2, List, ListOrdered, ListTodo, LoaderCircle, Microchip, Minus, Redo2, Save, Share2, Smile, Table, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MarkdownPreview } from '../../components/MarkdownPreview';
import { useResearchStore } from '../../hooks/useResearchStore';
import { buildCanonicalStockFileName, MARKDOWN_EXTENSION } from '../../hooks/useResearchStore';
import type { ThinkingPhase, ThinkingStatus } from '../../hooks/useResearchStore';
import { composeMarkdown, splitFrontmatter } from '../../lib/frontmatter';
import { listNewResearchTasks, updateFile } from '../../lib/dataApi';
import type { FrontmatterModel, NewResearchTask } from '../../types/models';
import { MetadataPanel } from '../metadata/MetadataPanel';
import { getAttachmentDiagnosticReasonMap } from '../metadata/attachmentUx';
import { useDialog } from '../../components/ui/DialogProvider';
import { getAgentSettings } from '../../lib/agentApi';
import type { AgentProvider } from '../agent/types';
import type { IngestionDiagnostics, StreamSource, ThinkingEvent } from '../../lib/agentApi';
import { reconcileDraftFrontmatterWithSaved } from '../files/effectiveNoteState';
import { runUiAsync } from '../../lib/uiAsync';

const EMOJIS = ['🔥', '✅', '📌', '🧠', '🚀', '💡', '⚠️', '📊', '🎯', '📝', '🤖', '🔍', '📣', '🧩', '💬', '✨'];
const THINKING_VISIBLE_LINE_LIMIT = 5;
const THINKING_SUCCESS_AUTO_CLOSE_MS = 3000;
const STREAM_UI_THROTTLE_MS = 150;
const SYNTHETIC_PROGRESS_REFINING_THRESHOLD = 280;
const SYNTHETIC_PROGRESS_MESSAGES = {
  drafting: 'LLM: Starting draft',
  refining: 'LLM: Refining structure',
  finalizing: 'LLM: Finalizing note',
} as const;

export const hasIngestionTruncationOrExclusion = (diagnostics: IngestionDiagnostics | null): boolean => (
  Boolean(diagnostics)
  && (
    (diagnostics?.partially_included_attachments ?? 0) > 0
    || (diagnostics?.excluded_attachments ?? 0) > 0
  )
);


type ThinkingStatusUi = {
  label: string;
  badgeClassName: string;
};

type StreamPreviewControllerOptions = {
  throttleMs: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timerId: number) => void;
  onApply: (nextText: string) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

type StreamPreviewController = {
  onChunk: (nextText: string) => void;
  complete: (finalText: string) => void;
  cancel: () => void;
};

export const createStreamPreviewController = ({
  throttleMs,
  now = () => Date.now(),
  setTimer = (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer = (timerId) => window.clearTimeout(timerId),
  onApply,
  onError,
}: StreamPreviewControllerOptions): StreamPreviewController => {
  let streamBuffer = '';
  let lastAppliedAt = 0;
  let lastAppliedText = '';
  let timerId: number | null = null;
  let active = true;

  const clearPendingTimer = () => {
    if (timerId === null) return;
    clearTimer(timerId);
    timerId = null;
  };

  const safeApply = (nextText: string) => {
    try {
      void onApply(nextText);
    } catch (error) {
      if (onError) void onError(error);
    }
  };

  const flush = () => {
    if (!active) return;
    if (!streamBuffer || streamBuffer === lastAppliedText) return;
    const nowMs = now();
    if (nowMs - lastAppliedAt < throttleMs) return;
    lastAppliedAt = nowMs;
    lastAppliedText = streamBuffer;
    safeApply(streamBuffer);
  };

  const scheduleFlush = () => {
    if (!active || timerId !== null) return;
    const elapsedSinceApply = now() - lastAppliedAt;
    const delay = Math.max(0, throttleMs - elapsedSinceApply);
    timerId = setTimer(() => {
      timerId = null;
      flush();
    }, delay);
  };

  return {
    onChunk: (nextText: string) => {
      if (!active) return;
      streamBuffer = nextText;
      flush();
      scheduleFlush();
    },
    complete: (finalText: string) => {
      if (!active) return;
      clearPendingTimer();
      streamBuffer = '';
      if (finalText && finalText !== lastAppliedText) {
        lastAppliedAt = now();
        lastAppliedText = finalText;
        safeApply(finalText);
      }
    },
    cancel: () => {
      active = false;
      clearPendingTimer();
      streamBuffer = '';
    },
  };
};

export const getThinkingStatusUi = (status: ThinkingStatus): ThinkingStatusUi => {
  switch (status) {
    case 'running':
      return { label: 'running', badgeClassName: 'bg-indigo-100 text-indigo-700' };
    case 'completed':
      return { label: 'completed', badgeClassName: 'bg-emerald-100 text-emerald-700' };
    case 'cancelled':
      return { label: 'cancelled', badgeClassName: 'bg-slate-200 text-slate-700' };
    case 'failed':
      return { label: 'failed', badgeClassName: 'bg-rose-100 text-rose-700' };
    default:
      return { label: 'idle', badgeClassName: 'bg-slate-100 text-slate-600' };
  }
};

export const getThinkingPhaseLabel = (phase: ThinkingPhase): string => {
  switch (phase) {
    case 'waiting':
      return 'Waiting';
    case 'reasoning':
      return 'Reasoning';
    case 'tool_running':
      return 'Running tools';
    case 'tool_completed':
      return 'Tool step complete';
    case 'tool_failed':
      return 'Tool step failed';
    default:
      return 'Waiting';
  }
};



export const shouldShowThinkingBubble = ({
  thinkingStatus,
  thinkingEventCount,
  isThinkingBubbleClosed,
}: {
  thinkingStatus: ThinkingStatus;
  thinkingEventCount: number;
  isThinkingBubbleClosed: boolean;
}) => (thinkingStatus !== 'idle' || thinkingEventCount > 0) && !isThinkingBubbleClosed;

export const formatThinkingModelBadge = (provider: string, model: string): string | null => {
  const trimmedModel = model.trim();
  if (!trimmedModel) return null;
  const trimmedProvider = provider.trim();
  return trimmedProvider ? `${trimmedProvider} · ${trimmedModel}` : trimmedModel;
};

const toFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const toStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
};

const extractQueryFromThinkingEvent = (event: ThinkingEvent): string | null => {
  const raw = event.raw as Record<string, unknown>;
  const directQuery = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (directQuery) return directQuery;
  if (raw.args && typeof raw.args === 'object') {
    const argsQuery = (raw.args as Record<string, unknown>).query;
    if (typeof argsQuery === 'string' && argsQuery.trim()) return argsQuery.trim();
  }
  return null;
};

export const normalizeThinkingEvent = (event: ThinkingEvent): string | null => {
  const raw = event.raw as Record<string, unknown>;
  const toolName = ('toolName' in event && typeof event.toolName === 'string') ? event.toolName.trim() : undefined;
  const lowerToolName = toolName?.toLowerCase() ?? '';
  const isSearchTool = lowerToolName.includes('search') || lowerToolName.includes('web') || lowerToolName.includes('browse');
  if (event.type === 'reasoning') {
    const summary = typeof event.summary === 'string' ? event.summary.trim() : '';
    const message = typeof event.message === 'string' ? event.message.trim() : '';
    if (summary) return summary;
    if (message) return message;
    return 'Reasoning step updated';
  }
  if (event.type === 'tool_call_started') {
    const query = extractQueryFromThinkingEvent(event);
    if (isSearchTool) {
      return query ? `Searching: "${query}"` : 'Searching the web';
    }
    return toolName ? `Running ${toolName}` : 'Running tool';
  }
  if (event.type === 'tool_call_result') {
    const query = extractQueryFromThinkingEvent(event);
    const sourceCount = toFiniteNumber(raw.sourceCount) ?? toFiniteNumber(raw.source_count);
    const attempt = toFiniteNumber(raw.attempt) ?? toFiniteNumber(raw.pass) ?? toFiniteNumber(raw.pass_index);
    const maxAttempts = toFiniteNumber(raw.maxAttempts) ?? toFiniteNumber(raw.max_attempts) ?? toFiniteNumber(raw.total_passes);
    const latencyMs = toFiniteNumber(raw.latencyMs) ?? toFiniteNumber(raw.latency_ms);
    const sourceMeta = raw.sourceMeta && typeof raw.sourceMeta === 'object' ? raw.sourceMeta as Record<string, unknown> : null;
    const topDomains = sourceMeta ? toStringList(sourceMeta.topDomains) : [];
    const fallbackDomains = toStringList(raw.domains);
    const domainList = (topDomains.length > 0 ? topDomains : fallbackDomains).slice(0, 3);
    if (isSearchTool) {
      const detailSegments: string[] = [];
      if (query) detailSegments.push(`"${query}"`);
      if (typeof attempt === 'number' && typeof maxAttempts === 'number') detailSegments.push(`pass ${attempt}/${maxAttempts}`);
      if (typeof sourceCount === 'number') detailSegments.push(`${sourceCount} sources`);
      if (domainList.length > 0) detailSegments.push(`domains: ${domainList.join(', ')}`);
      if (typeof latencyMs === 'number') detailSegments.push(`${Math.round(latencyMs)}ms`);
      if (detailSegments.length > 0) return `Search complete — ${detailSegments.join(' · ')}`;
      return 'Search completed';
    }
    if (domainList.length > 0) return `Sources checked: ${domainList.join(', ')}`;
    return toolName ? `${toolName} completed` : 'Tool completed';
  }
  if (event.type === 'tool_call_failed') {
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (isSearchTool) return reason ? `Search failed: ${reason}` : 'Search failed';
    if (reason) return `${toolName ? `${toolName} failed` : 'Tool failed'}: ${reason}`;
    return toolName ? `${toolName} failed` : 'Tool failed';
  }
  return null;
};

const streamSourceKey = (source: StreamSource) => (
  source.kind === 'web' ? `web:${source.url}` : `attachment:${source.attachment_id}`
);

export const mergeSourcesForBubble = (existing: StreamSource[], incoming: StreamSource[]): StreamSource[] => {
  if (incoming.length === 0) return existing;
  const merged: StreamSource[] = [];
  const seen = new Set<string>();

  const pushUnique = (source: StreamSource) => {
    const key = streamSourceKey(source);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(source);
  };

  incoming.forEach(pushUnique);
  existing.forEach(pushUnique);
  return merged;
};

export const applyTextToEditorState = (
  state: EditorState,
  nextText: string,
  addToHistory: boolean,
  isolate = false,
): EditorState => {
  const currentText = state.doc.toString();
  if (currentText === nextText) return state;
  const nextAnchor = Math.min(state.selection.main.anchor, nextText.length);
  const transaction = state.update({
    changes: { from: 0, to: state.doc.length, insert: nextText },
    selection: { anchor: nextAnchor },
    annotations: [Transaction.addToHistory.of(addToHistory), ...(isolate ? [isolateHistory.of('full')] : [])],
    scrollIntoView: true,
  });
  return transaction.state;
};

const URL_LIKE_PATTERN = /^(https?:\/\/|www\.)\S+$/i;

export const isUrlLikeSelection = (value: string) => URL_LIKE_PATTERN.test(value.trim());

export const deriveLinkLabelFromUrl = (value: string) => {
  try {
    const normalized = value.startsWith('http://') || value.startsWith('https://') ? value : `https://${value}`;
    const parsed = new URL(normalized);
    const cleanPath = parsed.pathname.replace(/\/$/, '');
    const pathSuffix = cleanPath && cleanPath !== '/' ? cleanPath.split('/').slice(-1)[0] : '';
    return pathSuffix ? `${parsed.hostname}/${pathSuffix}` : parsed.hostname;
  } catch {
    return 'link';
  }
};

export const getTableSizeError = (raw: string, label: 'Rows' | 'Columns') => {
  if (!/^\d+$/.test(raw.trim())) return `${label} must be an integer from 1 to 20.`;
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1 || parsed > 20) return `${label} must be between 1 and 20.`;
  return null;
};

export const buildMarkdownTable = (rows: number, cols: number) => {
  const header = `| ${Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ')} |`;
  const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
  const bodyRows = Array.from({ length: rows }, () => `| ${Array.from({ length: cols }, () => ' ').join(' | ')} |`).join('\n');
  return `${header}\n${sep}\n${bodyRows}`;
};

export const EDITOR_SHORTCUT_KEYS = {
  undo: ['Mod-z'],
  redo: ['Mod-Shift-z', 'Ctrl-y'],
  save: ['Mod-s'],
  bold: ['Mod-b'],
  italic: ['Mod-i'],
  h1: ['Mod-Alt-1'],
  h2: ['Mod-Alt-2'],
  h3: ['Mod-Alt-3'],
  link: ['Mod-k'],
  editTab: ['Mod-Shift-e'],
  previewTab: ['Mod-Shift-p'],
  splitTab: ['Mod-Shift-\\'],
  find: ['Mod-f'],
  replace: ['Mod-h'],
  generate: ['Mod-Enter'],
  cancelGenerate: ['Escape'],
} as const;

export function EditorPane() {
  const {
    workspace,
    files,
    selectedFileId,
    refresh,
    noteTypes,
    sectors,
    metadataPanelCollapsed,
    setMetadataPanelCollapsed,
    transitionTaskModal,
    editorTab,
    setEditorTab,
    getDraft,
    setDraft,
    clearDraft,
    getGenerateJob,
    clearGenerateJob,
    startGenerate,
    preflightGenerate,
    cancelGenerate: cancelGenerateByFileId,
    generatedSourcesByFileId,
    sourcesBubbleClosedByFileId,
    thinkingEventsByFileId,
    thinkingBubbleClosedByFileId,
    thinkingStatusByFileId,
    thinkingPhaseByFileId,
    thinkingAttemptByFileId,
    thinkingMaxAttemptsByFileId,
    thinkingStartedAtByFileId,
    resetGenerateTransientStateForFile,
    mergeIncomingSourcesForFile,
    appendThinkingEventsForFile,
    setSourcesBubbleClosedForFile,
    setThinkingBubbleClosedForFile,
    setThinkingMetadataForFile,
    markThinkingCompletedForFile,
    markThinkingCancelledForFile,
    markThinkingFailedForFile,
  } = useResearchStore();
  const navigate = useNavigate();
  const dialog = useDialog();
  const file = files.find((f) => f.id === selectedFileId);
  const viewRef = useRef<EditorView | null>(null);
  const viewFileIdRef = useRef<string | null>(null);
  const selectedFileIdRef = useRef<string | null>(selectedFileId);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableRowsInput, setTableRowsInput] = useState('3');
  const [tableColumnsInput, setTableColumnsInput] = useState('3');
  const [selectedEmoji, setSelectedEmoji] = useState<string>('🔥');
  const [showMetadata, setShowMetadata] = useState(false);
  const [linkedTask, setLinkedTask] = useState<NewResearchTask | null>(null);
  const [defaultProvider, setDefaultProvider] = useState<AgentProvider>('minimax');
  const [defaultModel, setDefaultModel] = useState('');
  const [showGeneratedDraftNotice, setShowGeneratedDraftNotice] = useState(false);
  const [thinkingClockTick, setThinkingClockTick] = useState(0);
  const [searchWarningMessage, setSearchWarningMessage] = useState<string | null>(null);
  const [ingestionDiagnosticsWarning, setIngestionDiagnosticsWarning] = useState<IngestionDiagnostics | null>(null);
  const [pendingPreflightDiagnostics, setPendingPreflightDiagnostics] = useState<IngestionDiagnostics | null>(null);
  const latestAttachmentIngestionReasons = getAttachmentDiagnosticReasonMap(
    pendingPreflightDiagnostics ?? ingestionDiagnosticsWarning,
  );
  const [showWarningDetails, setShowWarningDetails] = useState(false);
  const [canUndoByFileId, setCanUndoByFileId] = useState<Record<string, boolean>>({});
  const [canRedoByFileId, setCanRedoByFileId] = useState<Record<string, boolean>>({});
  const thinkingCloseTimerByFileIdRef = useRef<Record<string, number | null>>({});
  const originalTextByFileIdRef = useRef<Record<string, string | null>>({});
  const preGenerateVisibleTextByFileIdRef = useRef<Record<string, string | null>>({});
  const suppressOnChangeRef = useRef(0);
  const streamPreviewControllerRef = useRef<StreamPreviewController | null>(null);
  const isMountedRef = useRef(true);
  const streamFailureAlertShownByFileIdRef = useRef<Record<string, boolean>>({});
  const pendingHistoryBaselineByFileIdRef = useRef<Record<string, { beforeVisible: string; afterVisible: string } | null>>({});
  const editorStateByFileIdRef = useRef<Record<string, EditorState | null>>({});
  const skipPreflightOnceRef = useRef(false);
  const parsed = useMemo(
    () => splitFrontmatter(file?.content ?? '', { knownSectors: sectors, knownNoteTypes: noteTypes }),
    [file?.content, noteTypes, sectors],
  );
  const [body, setBody] = useState(parsed.body);
  const [frontmatter, setFrontmatter] = useState<FrontmatterModel>(parsed.frontmatter);

  useEffect(() => {
    selectedFileIdRef.current = selectedFileId;
  }, [selectedFileId]);

  const setCanUndoForFile = (fileId: string, value: boolean) => {
    setCanUndoByFileId((current) => ({ ...current, [fileId]: value }));
  };

  const setCanRedoForFile = (fileId: string, value: boolean) => {
    setCanRedoByFileId((current) => ({ ...current, [fileId]: value }));
  };

  const updateHistoryAvailabilityForFile = (fileId: string, state: EditorState | null) => {
    const resolvedState = state ?? editorStateByFileIdRef.current[fileId];
    setCanUndoForFile(fileId, resolvedState ? undoDepth(resolvedState) > 0 : false);
    setCanRedoForFile(fileId, resolvedState ? redoDepth(resolvedState) > 0 : false);
  };

  useEffect(() => {
    if (!file) {
      setBody(parsed.body);
      setFrontmatter(parsed.frontmatter);
      setShowGeneratedDraftNotice(false);
      return;
    }
    const cachedDraft = getDraft(file.id);
    if (cachedDraft) {
      const reconciledFrontmatter = reconcileDraftFrontmatterWithSaved(cachedDraft.frontmatter, parsed.frontmatter);
      if (reconciledFrontmatter !== cachedDraft.frontmatter) {
        setDraft(file.id, {
          ...cachedDraft,
          frontmatter: reconciledFrontmatter,
          updatedAt: Date.now(),
        });
      }
      setBody(cachedDraft.body);
      setFrontmatter(reconciledFrontmatter);
      const generateJob = getGenerateJob(file.id);
      setShowGeneratedDraftNotice(generateJob.status === 'completed' && cachedDraft.source === 'generate');
      return;
    }
    setBody(parsed.body);
    setFrontmatter(parsed.frontmatter);
    setShowGeneratedDraftNotice(false);
  }, [file, getDraft, getGenerateJob, parsed.body, parsed.frontmatter]);

  const updateDraftCache = (nextBody: string, nextFrontmatter: FrontmatterModel, source: 'manual' | 'generate') => {
    if (!file) return;
    setDraft(file.id, {
      body: nextBody,
      frontmatter: nextFrontmatter,
      source,
      updatedAt: Date.now(),
    });
  };

  useEffect(() => {
    // Force toolbar state to match the active note immediately when switching.
    // A keyed CodeMirror remount resets the live instance, so source toolbar state from cached editor state.
    if (viewRef.current && viewFileIdRef.current) {
      editorStateByFileIdRef.current[viewFileIdRef.current] = viewRef.current.state;
    }
    viewRef.current = null;
    viewFileIdRef.current = null;
    if (file?.id) {
      updateHistoryAvailabilityForFile(file.id, null);
    }
  }, [file?.id]);

  const dispatchEditorContent = (targetFileId: string, nextText: string, addToHistory: boolean, isolate = false) => {
    const view = viewRef.current;
    if (!view || viewFileIdRef.current !== targetFileId || selectedFileIdRef.current !== targetFileId) return false;
    const nextState = applyTextToEditorState(view.state, nextText, addToHistory, isolate);
    if (nextState === view.state) return true;
    suppressOnChangeRef.current += 1;
    view.setState(nextState);
    if (showMetadata) {
      const nextParsed = splitFrontmatter(nextText, { knownSectors: sectors, knownNoteTypes: noteTypes });
      setFrontmatter(nextParsed.frontmatter);
      setBody(nextParsed.body);
      updateDraftCache(nextParsed.body, nextParsed.frontmatter, 'manual');
    } else {
      setBody(nextText);
      updateDraftCache(nextText, frontmatter, 'manual');
    }
    editorStateByFileIdRef.current[targetFileId] = nextState;
    updateHistoryAvailabilityForFile(targetFileId, nextState);
    return true;
  };

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await getAgentSettings();
        if (cancelled) return;
        setDefaultProvider(settings.default_provider);
        const canonicalOllamaModel = settings.generation_params?.local_connection?.model?.trim() || settings.default_model;
        setDefaultModel(settings.default_provider === 'ollama' ? canonicalOllamaModel : settings.default_model);
      } catch {
        if (!cancelled) {
          setDefaultProvider('minimax');
          setDefaultModel('');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const clearThinkingCloseTimer = (fileId: string) => {
    const timer = thinkingCloseTimerByFileIdRef.current[fileId];
    if (timer) {
      window.clearTimeout(timer);
      thinkingCloseTimerByFileIdRef.current[fileId] = null;
    }
  };

  const metadataSyntax = useMemo(() => {
    const withFrontmatterOnly = composeMarkdown(frontmatter, '');
    const match = withFrontmatterOnly.match(/^---\n([\s\S]*?)\n---\n?$/);
    return match ? match[1] : '';
  }, [frontmatter]);

  const deriveThinkingPhase = (eventType: ThinkingEvent['type']): ThinkingPhase => {
    if (eventType === 'reasoning') return 'reasoning';
    if (eventType === 'tool_call_started') return 'tool_running';
    if (eventType === 'tool_call_result') return 'tool_completed';
    return 'tool_failed';
  };

  const extractAttemptData = (event: ThinkingEvent): { attempt?: number; maxAttempts?: number } => {
    const raw = event.raw as Record<string, unknown>;
    const attemptCandidates = [raw.attempt, raw.pass, raw.passIndex, raw.pass_index];
    const maxCandidates = [raw.maxAttempts, raw.max_attempts, raw.totalPasses, raw.total_passes];
    const attempt = attemptCandidates.find((value) => typeof value === 'number' && Number.isFinite(value));
    const maxAttempts = maxCandidates.find((value) => typeof value === 'number' && Number.isFinite(value));
    return {
      attempt: typeof attempt === 'number' ? attempt : undefined,
      maxAttempts: typeof maxAttempts === 'number' ? maxAttempts : undefined,
    };
  };

  useEffect(() => {
    const hasRunning = Object.values(thinkingStatusByFileId).some((status) => status === 'running');
    if (!hasRunning) return;
    const timer = window.setInterval(() => {
      setThinkingClockTick((tick) => tick + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [thinkingStatusByFileId]);

  useEffect(() => () => {
    Object.keys(thinkingCloseTimerByFileIdRef.current).forEach(clearThinkingCloseTimer);
  }, []);

  useEffect(() => () => {
    isMountedRef.current = false;
    streamPreviewControllerRef.current?.cancel();
    streamPreviewControllerRef.current = null;
  }, []);


  if (!file) return <div className="flex h-full items-center justify-center text-slate-400">Select a note to view</div>;

  const merged = composeMarkdown(frontmatter, body);
  const editorValue = showMetadata ? merged : body;
  const toVisibleEditorText = (nextBody: string, nextFrontmatter: FrontmatterModel): string =>
    showMetadata ? composeMarkdown(nextFrontmatter, nextBody) : nextBody;
  const dirty = merged !== file.content;
  const generatedSources = generatedSourcesByFileId[file.id] ?? [];
  const canUndo = canUndoByFileId[file.id] ?? false;
  const canRedo = canRedoByFileId[file.id] ?? false;
  const isSourcesBubbleClosed = sourcesBubbleClosedByFileId[file.id] ?? false;
  const thinkingEvents = thinkingEventsByFileId[file.id] ?? [];
  const isThinkingBubbleClosed = thinkingBubbleClosedByFileId[file.id] ?? false;
  const thinkingStatus = thinkingStatusByFileId[file.id] ?? 'idle';
  const thinkingPhase = thinkingPhaseByFileId[file.id] ?? 'waiting';
  const thinkingAttempt = thinkingAttemptByFileId[file.id];
  const thinkingMaxAttempts = thinkingMaxAttemptsByFileId[file.id];
  const thinkingStartedAt = thinkingStartedAtByFileId[file.id];
  const elapsedSeconds = thinkingStartedAt && thinkingStatus === 'running' ? Math.max(0, Math.floor((Date.now() - thinkingStartedAt) / 1000)) : 0;
  const thinkingStatusUi = getThinkingStatusUi(thinkingStatus);
  const thinkingPhaseLabel = getThinkingPhaseLabel(thinkingPhase);
  const thinkingModelBadgeLabel = formatThinkingModelBadge(defaultProvider, defaultModel);
  void thinkingClockTick;
  const isGenerateRunning = getGenerateJob(file.id).status === 'running';

  const formatDuration = (seconds: number) => {
    const mm = Math.floor(seconds / 60);
    const ss = seconds % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };

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

  const insertLink = async () => {
    const selectedText = getSelectedText();
    const hasSelection = selectedText.length > 0;

    if (hasSelection && !isUrlLikeSelection(selectedText)) {
      const url = await dialog.prompt('Insert link', '', 'URL');
      if (url === null) return;
      const replacement = `[${selectedText}](${url})`;
      if (!url.trim()) {
        applySelection(replacement, replacement.length - 1, replacement.length - 1);
        return;
      }
      insertAndMoveCaretRight(replacement);
      return;
    }

    if (hasSelection && isUrlLikeSelection(selectedText)) {
      const defaultLabel = deriveLinkLabelFromUrl(selectedText);
      const label = await dialog.prompt('Insert link', defaultLabel, 'Label');
      if (label === null) return;
      insertAndMoveCaretRight(`[${label || defaultLabel}](${selectedText})`);
      return;
    }

    const label = await dialog.prompt('Insert link', 'link text', 'Label');
    if (label === null) return;
    const url = await dialog.prompt('Insert link', '', 'URL');
    if (url === null) return;
    const nextLabel = label || 'link text';
    const replacement = `[${nextLabel}](${url})`;
    if (!url.trim()) {
      applySelection(replacement, replacement.length - 1, replacement.length - 1);
      return;
    }
    insertAndMoveCaretRight(replacement);
  };

  const openTableDialog = () => {
    setTableRowsInput('3');
    setTableColumnsInput('3');
    setTableDialogOpen(true);
  };

  const rowsError = getTableSizeError(tableRowsInput, 'Rows');
  const columnsError = getTableSizeError(tableColumnsInput, 'Columns');
  const tableDialogError = rowsError ?? columnsError;
  const canInsertTable = tableDialogError === null;

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

  const onUndo = () => {
    const targetFileId = file.id;
    const view = viewRef.current;
    if (!view || viewFileIdRef.current !== targetFileId) return;
    undo(view);
    editorStateByFileIdRef.current[targetFileId] = view.state;
    updateHistoryAvailabilityForFile(targetFileId, view.state);
    view.focus();
  };

  const onRedo = () => {
    const targetFileId = file.id;
    const view = viewRef.current;
    if (!view || viewFileIdRef.current !== targetFileId) return;
    redo(view);
    editorStateByFileIdRef.current[targetFileId] = view.state;
    updateHistoryAvailabilityForFile(targetFileId, view.state);
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

  const btn = (on: boolean) => `inline-flex items-center justify-center rounded border px-2 py-1 leading-none ${on ? 'border-slate-900 bg-slate-900 text-white' : ''}`;

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
    const bodyText = encodeURIComponent(merged);
    window.location.href = `mailto:?subject=${subject}&body=${bodyText}`;
  };

  const onSave = async () => {
    await runUiAsync(async () => {
      const { error } = await updateFile(file.id, {
        content: merged,
        frontmatter_json: frontmatter,
        is_template: !!frontmatter.template,
      });
      if (error) throw error;
      clearDraft(file.id);
      clearGenerateJob(file.id);
      setShowGeneratedDraftNotice(false);
      await refresh();
    }, {
      fallbackMessage: 'Failed to save note.',
      onError: async (message) => {
        await dialog.alert('Save failed', message);
      },
    });
  };

  const switchToTab = (tab: 'edit' | 'split' | 'preview') => {
    setEditorTab(tab);
  };

  const openFindPanel = () => {
    const view = viewRef.current;
    if (!view) return;
    openSearchPanel(view);
    view.focus();
  };

  const openReplacePanelInEditor = () => {
    const view = viewRef.current;
    if (!view) return;
    openSearchPanel(view);
    view.focus();
  };

  const runGenerate = async () => {
    if (isGenerateRunning) return;
    if (!defaultModel.trim()) {
      await dialog.alert('Generate unavailable', 'Set a default provider/model in Agent settings first.');
      return;
    }
    if (!skipPreflightOnceRef.current) {
      const preflightResult = await preflightGenerate(file.id, {
        inputText: merged,
        provider: defaultProvider,
        model: defaultModel,
      });
      if (preflightResult.predicted_truncation) {
        setPendingPreflightDiagnostics(preflightResult.diagnostics);
        setShowWarningDetails(false);
        return;
      }
    }
    skipPreflightOnceRef.current = false;

    const targetFileId = file.id;
    const originalText = merged;
    const preGenerateVisibleText = editorValue;
    originalTextByFileIdRef.current[targetFileId] = originalText;
    preGenerateVisibleTextByFileIdRef.current[targetFileId] = preGenerateVisibleText;
    pendingHistoryBaselineByFileIdRef.current[targetFileId] = null;
    clearThinkingCloseTimer(targetFileId);
    resetGenerateTransientStateForFile(file.id);
    setSearchWarningMessage(null);
    setIngestionDiagnosticsWarning(null);
    setPendingPreflightDiagnostics(null);
    setShowWarningDetails(false);
    streamPreviewControllerRef.current?.cancel();
    streamPreviewControllerRef.current = null;
    streamFailureAlertShownByFileIdRef.current[targetFileId] = false;
    const clearStreamRuntime = () => {
      streamPreviewControllerRef.current?.cancel();
      streamPreviewControllerRef.current = null;
    };

    const reportGeneratePhaseError = async (phase: 'stream_update' | 'finalize', error: unknown) => {
      console.error('Research generation phase failed', {
        provider: defaultProvider,
        model: defaultModel,
        fileId: targetFileId,
        phase,
        error,
      });
      if (streamFailureAlertShownByFileIdRef.current[targetFileId] || !isMountedRef.current) return;
      streamFailureAlertShownByFileIdRef.current[targetFileId] = true;
      await dialog.alert(
        'Generate encountered an issue',
        'We hit a temporary streaming issue. Your prior content has been preserved.',
      );
    };

    const applyStreamingPreviewText = async (nextOutputText: string) => {
      try {
        if (!isMountedRef.current) return;
        const view = viewRef.current;
        if (view && viewFileIdRef.current === targetFileId && selectedFileIdRef.current === targetFileId) {
          const nextState = applyTextToEditorState(view.state, nextOutputText, false);
          if (nextState !== view.state) {
            suppressOnChangeRef.current += 1;
            view.setState(nextState);
            editorStateByFileIdRef.current[targetFileId] = nextState;
            updateHistoryAvailabilityForFile(targetFileId, nextState);
          }
          return;
        }
        const cachedState = editorStateByFileIdRef.current[targetFileId];
        if (!cachedState) return;
        const nextState = applyTextToEditorState(cachedState, nextOutputText, false);
        editorStateByFileIdRef.current[targetFileId] = nextState;
        updateHistoryAvailabilityForFile(targetFileId, nextState);
      } catch (error) {
        const baselineText = preGenerateVisibleTextByFileIdRef.current[targetFileId];
        if (baselineText && isMountedRef.current) {
          dispatchEditorContent(targetFileId, baselineText, false);
        }
        await reportGeneratePhaseError('stream_update', error);
      }
    };

    const finalizeGeneratedOutput = async (outputText: string) => {
      try {
        const finalParsed = splitFrontmatter(outputText, { knownSectors: sectors, knownNoteTypes: noteTypes });
        const finalVisibleText = toVisibleEditorText(finalParsed.body, finalParsed.frontmatter);
        const baselineText = preGenerateVisibleTextByFileIdRef.current[targetFileId];
        if (baselineText) {
          const didApplyInEditor = dispatchEditorContent(targetFileId, baselineText, false);
          if (didApplyInEditor) {
            dispatchEditorContent(targetFileId, finalVisibleText, true, true);
            const view = viewRef.current;
            if (view && undo(view)) {
              const undoneText = view.state.doc.toString();
              if (undoneText !== baselineText) {
                console.warn('Generate undo checkpoint mismatch.', {
                  expected: baselineText,
                  actual: undoneText,
                });
              }
              redo(view);
              editorStateByFileIdRef.current[targetFileId] = view.state;
              updateHistoryAvailabilityForFile(targetFileId, view.state);
            }
          } else {
            const cachedState = editorStateByFileIdRef.current[targetFileId];
            if (cachedState) {
              const stateWithBaseline = applyTextToEditorState(cachedState, baselineText, false);
              const stateWithGeneratedOutput = applyTextToEditorState(stateWithBaseline, finalVisibleText, true, true);
              editorStateByFileIdRef.current[targetFileId] = stateWithGeneratedOutput;
              updateHistoryAvailabilityForFile(targetFileId, stateWithGeneratedOutput);
            } else {
              pendingHistoryBaselineByFileIdRef.current[targetFileId] = {
                beforeVisible: baselineText,
                afterVisible: finalVisibleText,
              };
            }
          }
        }
        setDraft(targetFileId, {
          body: finalParsed.body,
          frontmatter: finalParsed.frontmatter,
          source: 'generate',
          updatedAt: Date.now(),
        });
        if (selectedFileIdRef.current === targetFileId && isMountedRef.current) {
          setFrontmatter(finalParsed.frontmatter);
          setBody(finalParsed.body);
        }
      } catch (error) {
        const originalTextForFile = originalTextByFileIdRef.current[targetFileId];
        if (originalTextForFile && isMountedRef.current) {
          const restored = splitFrontmatter(originalTextForFile, { knownSectors: sectors, knownNoteTypes: noteTypes });
          dispatchEditorContent(targetFileId, toVisibleEditorText(restored.body, restored.frontmatter), false);
          setFrontmatter(restored.frontmatter);
          setBody(restored.body);
        }
        await reportGeneratePhaseError('finalize', error);
        throw error;
      }
    };

    const streamPreviewController = createStreamPreviewController({
      throttleMs: STREAM_UI_THROTTLE_MS,
      onApply: (nextOutputText) => {
        void applyStreamingPreviewText(nextOutputText);
      },
      onError: (error) => {
        void reportGeneratePhaseError('stream_update', error);
      },
    });
    streamPreviewControllerRef.current = streamPreviewController;
    let sawExplicitProviderThinkingEvent = false;
    let syntheticDraftingShown = false;
    let syntheticRefiningShown = false;
    let syntheticFinalizingShown = false;
    const appendSyntheticThinking = (message: string) => {
      setThinkingMetadataForFile(targetFileId, { phase: 'reasoning' });
      appendThinkingEventsForFile(targetFileId, [{ id: `${Date.now()}-synthetic`, text: message, type: 'reasoning' }]);
    };

    try {
      const outputText = await startGenerate(targetFileId, {
        inputText: originalText,
        provider: defaultProvider,
        model: defaultModel,
        onProgress: (nextOutputText) => {
          if (!sawExplicitProviderThinkingEvent && !syntheticDraftingShown) {
            syntheticDraftingShown = true;
            appendSyntheticThinking(SYNTHETIC_PROGRESS_MESSAGES.drafting);
          } else if (
            !sawExplicitProviderThinkingEvent
            && !syntheticRefiningShown
            && nextOutputText.trim().length >= SYNTHETIC_PROGRESS_REFINING_THRESHOLD
          ) {
            syntheticRefiningShown = true;
            appendSyntheticThinking(SYNTHETIC_PROGRESS_MESSAGES.refining);
          }
          streamPreviewController.onChunk(nextOutputText);
        },
        onSources: (sources) => {
          mergeIncomingSourcesForFile(targetFileId, sources);
          setSourcesBubbleClosedForFile(targetFileId, false);
        },
        onSearchWarning: (message) => {
          setSearchWarningMessage(message);
        },
        onIngestionDiagnostics: (diagnostics) => {
          if (hasIngestionTruncationOrExclusion(diagnostics)) {
            setIngestionDiagnosticsWarning(diagnostics);
          }
        },
        onThinkingEvent: (event) => {
          sawExplicitProviderThinkingEvent = true;
          const normalized = normalizeThinkingEvent(event);
          const { attempt, maxAttempts } = extractAttemptData(event);
          setThinkingMetadataForFile(targetFileId, { phase: deriveThinkingPhase(event.type) });
          if (typeof attempt === 'number') {
            setThinkingMetadataForFile(targetFileId, { attempt });
          }
          if (typeof maxAttempts === 'number') {
            setThinkingMetadataForFile(targetFileId, { maxAttempts });
          }
          if (!normalized) return;
          appendThinkingEventsForFile(targetFileId, [{ id: `${Date.now()}-${event.type}`, text: normalized, type: event.type }]);
        },
      });
      streamPreviewController.complete(outputText);
      clearStreamRuntime();
      if (!sawExplicitProviderThinkingEvent && !syntheticFinalizingShown) {
        syntheticFinalizingShown = true;
        appendSyntheticThinking(SYNTHETIC_PROGRESS_MESSAGES.finalizing);
      }
      await finalizeGeneratedOutput(outputText);
      const generatedDraft = getDraft(targetFileId);
      markThinkingCompletedForFile(targetFileId);
      clearThinkingCloseTimer(targetFileId);
      thinkingCloseTimerByFileIdRef.current[targetFileId] = window.setTimeout(() => {
        setThinkingBubbleClosedForFile(targetFileId, true);
      }, THINKING_SUCCESS_AUTO_CLOSE_MS);
      if (generatedDraft && selectedFileIdRef.current === targetFileId) {
        setFrontmatter(generatedDraft.frontmatter);
        setBody(generatedDraft.body);
      }
      if (selectedFileIdRef.current === targetFileId) {
        setShowGeneratedDraftNotice(true);
      }
    } catch (error) {
      clearStreamRuntime();
      const isCancelled = error instanceof Error && error.name === 'AbortError';
      if (isCancelled) {
        const originalTextForFile = originalTextByFileIdRef.current[targetFileId];
        if (originalTextForFile) {
          const restored = splitFrontmatter(originalTextForFile, { knownSectors: sectors, knownNoteTypes: noteTypes });
          if (selectedFileIdRef.current === targetFileId) {
            dispatchEditorContent(targetFileId, toVisibleEditorText(restored.body, restored.frontmatter), false);
            setFrontmatter(restored.frontmatter);
            setBody(restored.body);
          }
          setDraft(targetFileId, {
            body: restored.body,
            frontmatter: restored.frontmatter,
            source: 'manual',
            updatedAt: Date.now(),
          });
        }
        markThinkingCancelledForFile(targetFileId);
        clearThinkingCloseTimer(targetFileId);
        setThinkingBubbleClosedForFile(targetFileId, true);
        await dialog.alert('Generation cancelled', 'The generate request was cancelled. Original content is preserved.');
      } else {
        const originalTextForFile = originalTextByFileIdRef.current[targetFileId];
        if (originalTextForFile) {
          const restored = splitFrontmatter(originalTextForFile, { knownSectors: sectors, knownNoteTypes: noteTypes });
          if (selectedFileIdRef.current === targetFileId) {
            dispatchEditorContent(targetFileId, toVisibleEditorText(restored.body, restored.frontmatter), false);
            setFrontmatter(restored.frontmatter);
            setBody(restored.body);
          }
          setDraft(targetFileId, {
            body: restored.body,
            frontmatter: restored.frontmatter,
            source: 'manual',
            updatedAt: Date.now(),
          });
        }
        markThinkingFailedForFile(targetFileId);
        clearThinkingCloseTimer(targetFileId);
        setThinkingBubbleClosedForFile(targetFileId, false);
        await dialog.alert('Generate failed', error instanceof Error ? error.message : 'Generation failed. Original content is preserved.');
      }
    } finally {
      clearStreamRuntime();
      originalTextByFileIdRef.current[targetFileId] = null;
      preGenerateVisibleTextByFileIdRef.current[targetFileId] = null;
    }
  };

  const cancelGenerate = () => {
    streamPreviewControllerRef.current?.cancel();
    streamPreviewControllerRef.current = null;
    cancelGenerateByFileId(file.id);
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
                  onClick={() => switchToTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button className="inline-flex items-center rounded-md border px-2 py-1 text-xs" onClick={downloadCurrent} title="Download" aria-label="Download"><Download className="mr-1" size={14} />Download</button>
              <button className="inline-flex items-center rounded-md border px-2 py-1 text-xs" onClick={shareCurrent} title="Share" aria-label="Share"><Share2 className="mr-1" size={14} />Share</button>
              <button className="inline-flex items-center rounded-md border px-2 py-1 text-xs" onClick={() => navigator.clipboard.writeText(merged)}><Copy className="mr-1" size={14} />Copy</button>
              {isGenerateRunning ? (
                <button className="inline-flex items-center rounded-md border border-amber-400 px-2 py-1 text-xs text-amber-700" onClick={cancelGenerate}>
                  <LoaderCircle className="mr-1 animate-spin" size={14} />
                  <X className="mr-1" size={14} />Cancel
                </button>
              ) : (
                <button className="inline-flex items-center rounded-md border px-2 py-1 text-xs disabled:opacity-50" onClick={() => void runGenerate()} disabled={!defaultModel.trim()}>
                  <span className="relative mr-3 inline-flex items-center">
                    <Microchip className="inline" size={14} />
                    <span className="absolute -right-2 -top-0.5 rounded bg-slate-900 px-1 text-[8px] leading-tight text-white">AI</span>
                  </span>
                  Generate
                </button>
              )}
              <button
                className="inline-flex items-center rounded-md bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-50"
                disabled={!dirty || isGenerateRunning}
                onClick={() => void onSave()}
              >
                <Save className="mr-1" size={14} />Save {dirty ? '*' : ''}
              </button>
            </div>
          </div>
          {showGeneratedDraftNotice && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <span>Note successfully drafted - review and save</span>
              <button
                className="rounded border border-emerald-300 px-2 py-1"
                onClick={() => {
                  setShowGeneratedDraftNotice(false);
                  clearGenerateJob(file.id);
                }}
              >
                Dismiss
              </button>
            </div>
          )}
          {shouldShowThinkingBubble({ thinkingStatus, thinkingEventCount: thinkingEvents.length, isThinkingBubbleClosed }) && (
            <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="font-semibold text-indigo-900">Thinking</p>
                    {thinkingModelBadgeLabel && (
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                        {thinkingModelBadgeLabel}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${thinkingStatusUi.badgeClassName}`}>{thinkingStatusUi.label}</span>
                    <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">{thinkingPhaseLabel}</span>
                    {typeof thinkingAttempt === 'number' && typeof thinkingMaxAttempts === 'number' && (
                      <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
                        pass {thinkingAttempt}/{thinkingMaxAttempts}
                      </span>
                    )}
                    {thinkingStatus === 'running' && (
                      <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
                        elapsed {formatDuration(elapsedSeconds)}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded border border-indigo-200 p-0.5 text-indigo-500 transition-colors hover:text-indigo-700"
                  aria-label="Close thinking"
                  title="Close thinking"
                  onClick={() => {
                    clearThinkingCloseTimer(file.id);
                    setThinkingBubbleClosedForFile(file.id, true);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
              <div className="mt-2 space-y-1">
                {thinkingEvents.slice(-THINKING_VISIBLE_LINE_LIMIT).map((event) => (
                  <div key={event.id} className="flex items-start gap-2 rounded-sm bg-white/60 px-2 py-1">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />
                    <span className="leading-4">{event.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(searchWarningMessage || pendingPreflightDiagnostics || ingestionDiagnosticsWarning) && (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <div className="flex items-start justify-between gap-2">
                <div className="inline-flex items-center gap-2">
                  <span className="rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">Warning</span>
                  <span>
                    {pendingPreflightDiagnostics
                      ? 'Some attachments may be truncated or excluded based on token budget.'
                      : 'Generation completed with warning details.'}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {(pendingPreflightDiagnostics || ingestionDiagnosticsWarning) && (
                    <button type="button" className="rounded border border-amber-300 px-2 py-0.5 text-[11px]" onClick={() => setShowWarningDetails((value) => !value)}>
                      {showWarningDetails ? 'Hide details' : 'Show details'}
                    </button>
                  )}
                  {pendingPreflightDiagnostics && (
                    <>
                      <button type="button" className="rounded border border-amber-300 px-2 py-0.5 text-[11px]" onClick={() => setPendingPreflightDiagnostics(null)}>Cancel</button>
                      <button
                        type="button"
                        className="rounded border border-amber-500 bg-amber-100 px-2 py-0.5 text-[11px] font-semibold"
                        onClick={() => {
                          skipPreflightOnceRef.current = true;
                          setPendingPreflightDiagnostics(null);
                          void runGenerate();
                        }}
                      >
                        Continue
                      </button>
                    </>
                  )}
                </div>
              </div>
              {showWarningDetails && (pendingPreflightDiagnostics || ingestionDiagnosticsWarning) && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4">
                  {(pendingPreflightDiagnostics ?? ingestionDiagnosticsWarning)?.files
                    .filter((entry) => entry.reason !== 'included_full')
                    .map((entry) => (
                      <li key={`${entry.attachment_id}-${entry.reason}`}>{entry.filename}: {entry.reason.replace('_', ' ')}</li>
                    ))}
                </ul>
              )}
              {searchWarningMessage && <div className="mt-1">{searchWarningMessage}</div>}
            </div>
          )}
          {generatedSources.length > 0 && !isSourcesBubbleClosed && (
            <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-slate-900">Sources</p>
                <button
                  type="button"
                  className="rounded border border-slate-300 p-0.5 text-slate-500 transition-colors hover:text-slate-700"
                  aria-label="Close sources"
                  title="Close sources"
                  onClick={() => setSourcesBubbleClosedForFile(file.id, true)}
                >
                  <X size={12} />
                </button>
              </div>
              <ul className="mt-1 space-y-1">
                {generatedSources.map((source, index) => (
                  <li key={source.kind === 'web' ? `${source.url}-${index}` : `${source.attachment_id}-${index}`}>
                    {source.kind === 'web' ? (
                      <>
                        <span className="mr-1 font-mono text-[10px] text-slate-500">[{index + 1}]</span>
                        <a className="text-blue-700 hover:underline" href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a>
                      </>
                    ) : (
                      <>
                        <span className="mr-1 inline-flex rounded bg-violet-100 px-1.5 py-0.5 font-mono text-[10px] text-violet-700">[{source.label}]</span>
                        <span className="font-medium text-violet-800">{source.label}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {shouldRenderEditableEditor(editorTab) && (
            <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-slate-100 pt-2 text-xs">
            <button className={`${btn(false)} disabled:cursor-not-allowed disabled:opacity-40`} onClick={onUndo} title="Undo" aria-label="Undo" disabled={!canUndo}><Undo2 size={14} /></button>
            <button className={`${btn(false)} disabled:cursor-not-allowed disabled:opacity-40`} onClick={onRedo} title="Redo" aria-label="Redo" disabled={!canRedo}><Redo2 size={14} /></button>
            <span className="select-none px-1 text-slate-300" aria-hidden="true">|</span>
            <button className={btn(active.h1)} onClick={() => toggleHeading(1)}><span className="font-semibold">H</span><span className={`text-[10px] ${active.h1 ? 'text-white/70' : 'text-slate-500'}`}>1</span></button>
            <button className={btn(active.h2)} onClick={() => toggleHeading(2)}><span className="font-semibold">H</span><span className={`text-[10px] ${active.h2 ? 'text-white/70' : 'text-slate-500'}`}>2</span></button>
            <button className={btn(active.h3)} onClick={() => toggleHeading(3)}><span className="font-semibold">H</span><span className={`text-[10px] ${active.h3 ? 'text-white/70' : 'text-slate-500'}`}>3</span></button>
            <button className={btn(active.bold)} onClick={() => toggleWrap('**', 'bold text')}><strong>Bold</strong></button>
            <button className={btn(active.italic)} onClick={() => toggleWrap('*', 'italic text')}><em>Italic</em></button>
            <button className={btn(active.ul)} onClick={() => toggleLinePrefix('- ')}><List size={14} /></button>
            <button className={btn(active.ol)} onClick={toggleOrderedList}><ListOrdered size={14} /></button>
            <button className={btn(active.task)} onClick={() => toggleLinePrefix('- [ ] ')}><ListTodo size={14} /></button>
            <button className={btn(active.hr)} onClick={toggleHorizontalRule}><Minus size={14} /></button>
            <button
              className="inline-flex items-center justify-center rounded border px-2 py-1 leading-none"
              title="Link"
              aria-label="Link"
              onClick={() => void insertLink()}
            >
              <Link2 className="align-middle" size={14} />
            </button>
            <button
              className="inline-flex items-center justify-center rounded border px-2 py-1 leading-none"
              title="Table"
              aria-label="Table"
              onClick={openTableDialog}
            >
              <Table className="align-middle" size={14} />
            </button>
            <button className="inline-flex items-center justify-center rounded border px-2 py-1 leading-none" onClick={() => setEmojiOpen(true)} title="Emoji" aria-label="Emoji"><Smile className="align-middle" size={14} /></button>
            </div>
          )}
        </div>

        <div className={`grid min-h-0 flex-1 ${editorTab === 'split' ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
          <div
            className={`${shouldRenderEditableEditor(editorTab) ? '' : 'hidden pointer-events-none'} min-h-0 flex-1`}
            aria-hidden={!shouldRenderEditableEditor(editorTab)}
          >
            <CodeMirror
              key={file.id}
              value={editorValue}
              className="pane-scroll min-h-0 flex-1"
              height="100%"
              extensions={[
                ...editorExtensions,
                keymap.of([
                  { key: EDITOR_SHORTCUT_KEYS.undo[0], run: () => { onUndo(); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.redo[0], run: () => { onRedo(); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.redo[1], run: () => { onRedo(); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.save[0], run: () => { void onSave(); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.bold[0], run: () => { toggleWrap('**', 'bold text'); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.italic[0], run: () => { toggleWrap('*', 'italic text'); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.h1[0], run: () => { toggleHeading(1); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.h2[0], run: () => { toggleHeading(2); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.h3[0], run: () => { toggleHeading(3); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.link[0], run: () => { void insertLink(); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.editTab[0], run: () => { switchToTab('edit'); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.previewTab[0], run: () => { switchToTab('preview'); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.splitTab[0], run: () => { switchToTab('split'); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.find[0], run: () => { openFindPanel(); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.replace[0], run: () => { openReplacePanelInEditor(); return true; } },
                  { key: EDITOR_SHORTCUT_KEYS.generate[0], run: () => { void runGenerate(); return true; } },
                  {
                    key: EDITOR_SHORTCUT_KEYS.cancelGenerate[0],
                    run: () => {
                      if (!isGenerateRunning) return false;
                      cancelGenerate();
                      return true;
                    },
                  },
                ]),
              ]}
              onCreateEditor={(view) => {
                viewRef.current = view;
                viewFileIdRef.current = file.id;
                const cachedEditorState = editorStateByFileIdRef.current[file.id];
                if (cachedEditorState) {
                  view.setState(cachedEditorState);
                } else {
                  editorStateByFileIdRef.current[file.id] = view.state;
                }
                const pendingBaseline = pendingHistoryBaselineByFileIdRef.current[file.id];
                if (pendingBaseline) {
                  dispatchEditorContent(file.id, pendingBaseline.beforeVisible, false);
                  dispatchEditorContent(file.id, pendingBaseline.afterVisible, true, true);
                  pendingHistoryBaselineByFileIdRef.current[file.id] = null;
                }
                updateHistoryAvailabilityForFile(file.id, view.state);
              }}
              onChange={(v) => {
                if (suppressOnChangeRef.current > 0) {
                  suppressOnChangeRef.current -= 1;
                  return;
                }
                if (showMetadata) {
                  const nextParsed = splitFrontmatter(v, { knownSectors: sectors, knownNoteTypes: noteTypes });
                  setFrontmatter(nextParsed.frontmatter);
                  setBody(nextParsed.body);
                  updateDraftCache(nextParsed.body, nextParsed.frontmatter, 'manual');
                  return;
                }
                setBody(v);
                updateDraftCache(v, frontmatter, 'manual');
              }}
              onUpdate={(viewUpdate) => {
                if (viewFileIdRef.current !== file.id) return;
                editorStateByFileIdRef.current[file.id] = viewUpdate.state;
                updateHistoryAvailabilityForFile(file.id, viewUpdate.state);
              }}
            />
          </div>
          {(editorTab === 'preview' || editorTab === 'split') && (
            <div className={`markdown-preview pane-scroll max-w-none overflow-x-auto overflow-y-auto bg-white px-5 pb-5 pt-2 text-sm ${editorTab === 'split' ? 'border-l border-slate-200' : ''}`}>
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
        onChange={(nextFrontmatter) => {
          setFrontmatter(nextFrontmatter);
          updateDraftCache(body, nextFrontmatter, 'manual');
        }}
        onIdentityBlur={async ({ date, ticker, type }) => {
          const nextDate = date.trim();
          const nextTicker = ticker.trim().toUpperCase();
          const nextType = type.trim();
          if (!nextDate || !nextTicker || !nextType) return;
          const nextName = `${buildCanonicalStockFileName(nextDate, nextTicker, nextType)}${MARKDOWN_EXTENSION}`;
          if (nextName === file.name) return;
          const folderPath = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
          const nextPath = folderPath ? `${folderPath}/${nextName}` : nextName;
          await runUiAsync(async () => {
            const { error } = await updateFile(file.id, { name: nextName, path: nextPath });
            if (error) throw error;
            await refresh();
          }, {
            fallbackMessage: 'Failed to rename note from metadata.',
            onError: async (message) => {
              await dialog.alert('Rename failed', message);
            },
          });
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
        viewTaskHelperText={linkedTask ? `Linked to task: ${linkedTask.title || linkedTask.ticker || linkedTask.id}` : 'No linked task for this note.'}
        workspaceId={workspace?.id ?? ''}
        noteId={file.id}
        linkedTaskId={linkedTask?.id}
        latestIngestionReasonsByAttachmentId={latestAttachmentIngestionReasons}
      />

      {tableDialogOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <h3 className="text-sm font-semibold">Insert table</h3>
            <div className="mt-3 flex items-center gap-2">
              <label className="text-sm text-slate-600" htmlFor="table-rows-input">Rows</label>
              <input
                id="table-rows-input"
                className="input"
                inputMode="numeric"
                autoFocus
                value={tableRowsInput}
                onChange={(event) => setTableRowsInput(event.target.value)}
                aria-label="Rows"
              />
              <span className="text-sm text-slate-500">x</span>
              <input
                id="table-columns-input"
                className="input"
                inputMode="numeric"
                value={tableColumnsInput}
                onChange={(event) => setTableColumnsInput(event.target.value)}
                aria-label="Columns"
              />
              <label className="text-sm text-slate-600" htmlFor="table-columns-input">Columns</label>
            </div>
            <p className="mt-1 text-xs text-slate-500">Rows × Columns (1..20 each)</p>
            {tableDialogError && <p className="mt-2 text-sm text-red-600">{tableDialogError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded-md border border-slate-300 px-3 py-1.5 text-sm" onClick={() => setTableDialogOpen(false)}>Cancel</button>
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canInsertTable}
                onClick={() => {
                  if (!canInsertTable) return;
                  const rows = Number.parseInt(tableRowsInput, 10);
                  const cols = Number.parseInt(tableColumnsInput, 10);
                  insertAndMoveCaretRight(buildMarkdownTable(rows, cols));
                  setTableDialogOpen(false);
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

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
