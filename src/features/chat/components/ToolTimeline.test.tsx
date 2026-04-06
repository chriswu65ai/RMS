import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolTimeline } from './ToolTimeline.js';
import type { ToolTraceEntry } from '../types.js';

const baseTrace = (overrides: Partial<ToolTraceEntry>): ToolTraceEntry => ({
  id: 'trace-1',
  toolName: 'response_generation',
  status: 'completed',
  detail: 'Final response generated.',
  startedAt: 1,
  ...overrides,
});

test('tool timeline hides response-generation-only traces', () => {
  const html = renderToStaticMarkup(
    <ToolTimeline traces={[baseTrace({ id: 'response-generation-only' })]} />,
  );

  assert.equal(html, '');
});

test('tool timeline keeps response-generation traces when actionable tool traces exist', () => {
  const html = renderToStaticMarkup(
    <ToolTimeline traces={[
      baseTrace({ id: 'response-generation-visible' }),
      baseTrace({ id: 'tool-call', toolName: 'create_task', detail: 'Created task.', status: 'completed' }),
    ]} />,
  );

  assert.match(html, /response_generation/);
  assert.match(html, /create_task/);
});
