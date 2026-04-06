import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('chat message bubbles preserve role-specific contrast classes', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/features/chat/components/ChatMessageItem.tsx'), 'utf8');

  assert.match(source, /\? 'bg-slate-900 text-white'/, 'user bubble should remain dark for contrast');
  assert.match(source, /\? 'border border-emerald-200 bg-emerald-50 text-emerald-900'/, 'system bubble should remain emerald variant');
  assert.match(source, /: 'border border-slate-300 bg-white text-slate-900';/, 'assistant bubble should use high-contrast white variant');
});

test('tool timeline container styles keep nested cards readable inside assistant bubble', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/features/chat/components/ToolTimeline.tsx'), 'utf8');

  assert.match(source, /<ol className="mt-2 space-y-2 rounded-lg border border-slate-300 bg-slate-50 p-3">/);
  assert.match(source, /<li key=\{trace\.id\} className="rounded-md border border-slate-200 bg-white p-2">/);
});
