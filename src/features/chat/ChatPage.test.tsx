import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSessionToolbar } from './components/ChatSessionToolbar.js';

const noop = async () => {};

test('chat session toolbar renders all session actions', () => {
  const markup = renderToStaticMarkup(createElement(ChatSessionToolbar, {
    disabled: false,
    onClearHistory: noop,
    onResetContext: noop,
    onExportJson: noop,
    onExportMarkdown: noop,
  }));

  assert.equal(markup.includes('Clear history'), true);
  assert.equal(markup.includes('Reset context'), true);
  assert.equal(markup.includes('Export JSON'), true);
  assert.equal(markup.includes('Export Markdown'), true);
});

test('chat session toolbar disables all actions while async session action is in-flight', () => {
  const markup = renderToStaticMarkup(createElement(ChatSessionToolbar, {
    disabled: true,
    onClearHistory: noop,
    onResetContext: noop,
    onExportJson: noop,
    onExportMarkdown: noop,
  }));

  const disabledCount = (markup.match(/disabled=""/g) ?? []).length;
  assert.equal(disabledCount, 4);
});
