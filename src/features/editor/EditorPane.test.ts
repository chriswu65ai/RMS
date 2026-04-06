import { history, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorExtensions, shouldRenderEditableEditor } from './editorSpellcheck.js';
import {
  applyTextToEditorState,
  buildMarkdownTable,
  createStreamPreviewController,
  deriveLinkLabelFromUrl,
  EDITOR_SHORTCUT_KEYS,
  getTableSizeError,
  getThinkingStatusUi,
  isUrlLikeSelection,
  mergeSourcesForBubble,
  shouldShowThinkingBubble,
} from './EditorPane.js';

test('editor stays mounted in edit and split tabs', () => {
  assert.equal(shouldRenderEditableEditor('edit'), true);
  assert.equal(shouldRenderEditableEditor('split'), true);
  assert.equal(shouldRenderEditableEditor('preview'), false);
});

test('editor extensions set spellcheck content attribute', () => {
  const state = EditorState.create({ extensions: editorExtensions });
  const contentAttributes = state.facet(EditorView.contentAttributes);

  const hasExpectedAttributes = contentAttributes.some((attrs) => (
    typeof attrs !== 'function'
    && attrs.spellcheck === 'true'
    && attrs.autocorrect === 'on'
    && attrs.autocapitalize === 'sentences'
  ));

  assert.equal(hasExpectedAttributes, true);
});

const applyUndo = (state: EditorState) => {
  let nextState = state;
  undo({
    state,
    dispatch: (transaction) => {
      nextState = transaction.state;
    },
  });
  return nextState;
};

const applyRedo = (state: EditorState) => {
  let nextState = state;
  redo({
    state,
    dispatch: (transaction) => {
      nextState = transaction.state;
    },
  });
  return nextState;
};

const createEditorState = (doc = '') => EditorState.create({ doc, extensions: [history()] });

test('multiple sequential undos/redos in one note use CodeMirror history only', () => {
  let state = createEditorState();
  state = applyTextToEditorState(state, 'step 1', true);
  state = applyTextToEditorState(state, 'step 2', true);
  state = applyTextToEditorState(state, 'step 3', true);
  assert.equal(undoDepth(state), 3);

  state = applyUndo(state);
  assert.equal(state.doc.toString(), 'step 2');
  state = applyUndo(state);
  assert.equal(state.doc.toString(), 'step 1');
  state = applyUndo(state);
  assert.equal(state.doc.toString(), '');

  assert.equal(undoDepth(state), 0);
  assert.equal(redoDepth(state), 3);

  state = applyRedo(state);
  assert.equal(state.doc.toString(), 'step 1');
  state = applyRedo(state);
  assert.equal(state.doc.toString(), 'step 2');
  state = applyRedo(state);
  assert.equal(state.doc.toString(), 'step 3');
  assert.equal(redoDepth(state), 0);
});

test('note switching and return preserve per-note history isolation', () => {
  const stateByFileId: Record<string, EditorState> = {
    noteA: createEditorState(),
    noteB: createEditorState(),
  };

  stateByFileId.noteA = applyTextToEditorState(stateByFileId.noteA, 'A1', true);
  stateByFileId.noteA = applyTextToEditorState(stateByFileId.noteA, 'A2', true);
  stateByFileId.noteB = applyTextToEditorState(stateByFileId.noteB, 'B1', true);

  stateByFileId.noteB = applyUndo(stateByFileId.noteB);
  assert.equal(stateByFileId.noteB.doc.toString(), '');
  assert.equal(stateByFileId.noteA.doc.toString(), 'A2');
  assert.equal(undoDepth(stateByFileId.noteA), 2);
});

test('no extra undo/redo steps after stack exhaustion', () => {
  let state = createEditorState();
  state = applyTextToEditorState(state, 'only step', true);

  state = applyUndo(state);
  assert.equal(state.doc.toString(), '');
  const exhaustedUndoState = applyUndo(state);
  assert.equal(exhaustedUndoState.doc.toString(), '');
  assert.equal(undoDepth(exhaustedUndoState), 0);

  state = applyRedo(exhaustedUndoState);
  assert.equal(state.doc.toString(), 'only step');
  const exhaustedRedoState = applyRedo(state);
  assert.equal(exhaustedRedoState.doc.toString(), 'only step');
  assert.equal(redoDepth(exhaustedRedoState), 0);
});

test('shortcut map includes required bindings and excludes list shortcuts', () => {
  assert.deepEqual(EDITOR_SHORTCUT_KEYS.redo, ['Mod-Shift-z', 'Ctrl-y']);
  assert.deepEqual(EDITOR_SHORTCUT_KEYS.find, ['Mod-f']);
  assert.deepEqual(EDITOR_SHORTCUT_KEYS.replace, ['Mod-h']);
  assert.deepEqual(EDITOR_SHORTCUT_KEYS.link, ['Mod-k']);
  assert.equal((Object.values(EDITOR_SHORTCUT_KEYS).flat() as string[]).includes('Mod-Shift-8'), false);
});

test('link helper detects url-like selections and creates label defaults', () => {
  assert.equal(isUrlLikeSelection('https://example.com/report'), true);
  assert.equal(isUrlLikeSelection('www.example.com/path'), true);
  assert.equal(isUrlLikeSelection('Quarterly outlook'), false);
  assert.equal(deriveLinkLabelFromUrl('https://example.com/research/report/'), 'example.com/report');
});

test('table validation enforces integer range 1..20', () => {
  assert.equal(getTableSizeError('0', 'Rows'), 'Rows must be between 1 and 20.');
  assert.equal(getTableSizeError('abc', 'Columns'), 'Columns must be an integer from 1 to 20.');
  assert.equal(getTableSizeError('20', 'Rows'), null);
});

test('table generator creates expected 3x3 markdown output', () => {
  assert.equal(
    buildMarkdownTable(3, 3),
    [
      '| Col 1 | Col 2 | Col 3 |',
      '| --- | --- | --- |',
      '|   |   |   |',
      '|   |   |   |',
      '|   |   |   |',
    ].join('\n'),
  );
});


test('thinking status UI maps failed and cancelled badges distinctly', () => {
  assert.deepEqual(getThinkingStatusUi('failed'), { label: 'failed', badgeClassName: 'bg-rose-100 text-rose-700' });
  assert.deepEqual(getThinkingStatusUi('cancelled'), { label: 'cancelled', badgeClassName: 'bg-slate-200 text-slate-700' });
  assert.deepEqual(getThinkingStatusUi('completed'), { label: 'completed', badgeClassName: 'bg-emerald-100 text-emerald-700' });
});

test('thinking bubble visibility keeps failures visible but hides cancelled when closed', () => {
  assert.equal(
    shouldShowThinkingBubble({ thinkingStatus: 'failed', thinkingEventCount: 0, isThinkingBubbleClosed: false }),
    true,
  );
  assert.equal(
    shouldShowThinkingBubble({ thinkingStatus: 'cancelled', thinkingEventCount: 2, isThinkingBubbleClosed: true }),
    false,
  );
  assert.equal(
    shouldShowThinkingBubble({ thinkingStatus: 'idle', thinkingEventCount: 0, isThinkingBubbleClosed: false }),
    false,
  );
});

type ScheduledTimer = { id: number; runAt: number; callback: () => void };

const createTimerHarness = () => {
  let nowMs = 0;
  let nextTimerId = 1;
  const timers: ScheduledTimer[] = [];

  const setTimer = (callback: () => void, delayMs: number) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.push({ id, runAt: nowMs + delayMs, callback });
    return id;
  };

  const clearTimer = (timerId: number) => {
    const index = timers.findIndex((timer) => timer.id === timerId);
    if (index >= 0) timers.splice(index, 1);
  };

  const advanceTo = (targetMs: number) => {
    nowMs = targetMs;
    const ready = timers
      .filter((timer) => timer.runAt <= nowMs)
      .sort((a, b) => a.runAt - b.runAt);
    ready.forEach((timer) => {
      clearTimer(timer.id);
      timer.callback();
    });
  };

  const pendingTimerCount = () => timers.length;

  return {
    now: () => nowMs,
    setTimer,
    clearTimer,
    advanceTo,
    pendingTimerCount,
  };
};

test('stream preview applies high-frequency chunks with throttling instead of mutating on every chunk', () => {
  const clock = createTimerHarness();
  const applied: string[] = [];
  const controller = createStreamPreviewController({
    throttleMs: 150,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onApply: (nextText) => {
      applied.push(nextText);
    },
  });

  for (let i = 1; i <= 30; i += 1) {
    controller.onChunk(`chunk-${i}`);
  }

  assert.equal(applied.length, 1);
  assert.equal(applied[0], 'chunk-1');
  clock.advanceTo(150);
  assert.deepEqual(applied, ['chunk-1', 'chunk-30']);
});

test('stream preview complete applies full output exactly once, even when done follows matching preview', () => {
  const clock = createTimerHarness();
  const applied: string[] = [];
  const controller = createStreamPreviewController({
    throttleMs: 150,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onApply: (nextText) => {
      applied.push(nextText);
    },
  });

  controller.onChunk('draft');
  clock.advanceTo(150);
  controller.onChunk('final output');
  clock.advanceTo(300);
  controller.complete('final output');

  assert.deepEqual(applied, ['draft', 'final output']);
});

test('sources bubble merge keeps injected attachments visible even if later updates omit them', () => {
  const injectedAttachment = { kind: 'attachment', attachment_id: 'doc-7', label: 'appendix.pdf' } as const;
  const first = mergeSourcesForBubble([], [injectedAttachment]);
  const second = mergeSourcesForBubble(first, [{ kind: 'web', title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' }]);

  assert.equal(second.some((source) => source.kind === 'attachment' && source.attachment_id === 'doc-7'), true);
  assert.equal(second.some((source) => source.kind === 'web' && source.url === 'https://example.com/a'), true);
});

test('sources bubble merge deduplicates repeated attachment and web entries', () => {
  const merged = mergeSourcesForBubble(
    [
      { kind: 'web', title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' },
      { kind: 'attachment', attachment_id: 'doc-1', label: 'one.pdf' },
    ],
    [
      { kind: 'web', title: 'Alpha duplicate title', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' },
      { kind: 'attachment', attachment_id: 'doc-1', label: 'one-renamed.pdf' },
      { kind: 'web', title: 'Beta', url: 'https://example.com/b', snippet: '', provider: 'duckduckgo' },
    ],
  );

  assert.equal(merged.filter((source) => source.kind === 'web' && source.url === 'https://example.com/a').length, 1);
  assert.equal(merged.filter((source) => source.kind === 'attachment' && source.attachment_id === 'doc-1').length, 1);
  assert.equal(merged.some((source) => source.kind === 'web' && source.url === 'https://example.com/b'), true);
});

test('malformed or interrupted chunk sequence errors are tolerated and future updates still apply', () => {
  const clock = createTimerHarness();
  const applied: string[] = [];
  const errors: unknown[] = [];
  const controller = createStreamPreviewController({
    throttleMs: 150,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onApply: (nextText) => {
      if (nextText === 'broken') throw new Error('malformed chunk');
      applied.push(nextText);
    },
    onError: (error) => {
      errors.push(error);
    },
  });

  controller.onChunk('broken');
  assert.equal(errors.length, 1);
  controller.onChunk('recovered');
  clock.advanceTo(150);
  assert.equal(errors.length, 1);
  assert.deepEqual(applied, ['recovered']);
});

test('cancellation clears pending flush and prevents stale scheduled updates', () => {
  const clock = createTimerHarness();
  const applied: string[] = [];
  const controller = createStreamPreviewController({
    throttleMs: 150,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onApply: (nextText) => {
      applied.push(nextText);
    },
  });

  controller.onChunk('initial');
  controller.onChunk('stale-pending');
  assert.equal(clock.pendingTimerCount(), 1);
  controller.cancel();
  assert.equal(clock.pendingTimerCount(), 0);

  clock.advanceTo(1000);
  controller.onChunk('ignored-after-cancel');
  assert.deepEqual(applied, ['initial']);
});
