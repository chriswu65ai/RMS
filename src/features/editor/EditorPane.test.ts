import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorExtensions, shouldRenderEditableEditor } from './editorSpellcheck.js';

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
