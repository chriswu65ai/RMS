import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('settings shell navigation is always expanded and links to general, AI, and attachments subpages', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/settings/SettingsLayout.tsx'), 'utf-8');
  assert.equal(source.includes('<nav aria-label="Settings sections" className="space-y-1">'), true);
  assert.equal(source.includes("{ to: 'general', label: 'General', id: 'settings-nav-general' }"), true);
  assert.equal(source.includes("{ to: 'ai', label: 'AI', id: 'settings-nav-ai' }"), true);
  assert.equal(source.includes("{ to: 'attachments', label: 'Attachments', id: 'settings-nav-attachments' }"), true);
  assert.equal(source.includes('settingsNavCollapsed'), false);
  assert.equal(source.includes('aria-expanded'), false);
});
