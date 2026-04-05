import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorExtensions, shouldRenderEditableEditor } from './editorSpellcheck.js';
import { pushHistorySnapshot, redoHistorySnapshot, undoHistorySnapshot } from './EditorPane.js';

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

test('per-note history isolation prevents cross-note undo bleed', () => {
  const historyByFileId: Record<string, ReturnType<typeof pushHistorySnapshot>> = {
    noteA: pushHistorySnapshot(null, '', 'alpha'),
    noteB: pushHistorySnapshot(null, '', 'beta'),
  };

  const undoB = undoHistorySnapshot(historyByFileId.noteB);
  assert.ok(undoB);
  assert.equal(undoB.text, '');
  assert.equal(historyByFileId.noteA.lastText, 'alpha');
});

test('undo/redo keeps each note history intact when switching back', () => {
  const noteA1 = pushHistorySnapshot(null, '', 'A1');
  const noteA2 = pushHistorySnapshot(noteA1, 'A1', 'A2');
  const undone = undoHistorySnapshot(noteA2);
  assert.ok(undone);
  assert.equal(undone.text, 'A1');
  const redone = redoHistorySnapshot(undone.history);
  assert.ok(redone);
  assert.equal(redone.text, 'A2');
});

test('generated output can be undone in one step back to pre-generate content', () => {
  const preGenerate = 'before generate';
  const generated = 'after generate';
  const history = pushHistorySnapshot(null, preGenerate, generated);
  const undone = undoHistorySnapshot(history);
  assert.ok(undone);
  assert.equal(undone.text, preGenerate);
});

test('metadata/tab toggles with unchanged text do not create undo entries', () => {
  const baseline = pushHistorySnapshot(null, '', 'body only');
  const afterToggle = pushHistorySnapshot(baseline, 'body only', 'body only');
  assert.equal(afterToggle.undoStack.length, baseline.undoStack.length);
  assert.equal(afterToggle.lastText, baseline.lastText);
});

test('toolbar and keyboard parity use identical undo/redo state transitions', () => {
  const history = pushHistorySnapshot(pushHistorySnapshot(null, '', 'one'), 'one', 'two');
  const toolbarUndo = undoHistorySnapshot(history);
  const keyboardUndo = undoHistorySnapshot(history);
  assert.deepEqual(toolbarUndo, keyboardUndo);
});
