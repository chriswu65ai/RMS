import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('settings shell navigation is always expanded and links to general, AI, and attachments subpages', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/settings/SettingsLayout.tsx'), 'utf-8');
  assert.equal(source.includes('aria-label="Settings sections"'), true);
  assert.match(source, /to:\s*'general',\s*label:\s*'General',\s*id:\s*'settings-nav-general'/);
  assert.match(source, /to:\s*'ai',\s*label:\s*'AI',\s*id:\s*'settings-nav-ai'/);
  assert.match(source, /to:\s*'attachments',\s*label:\s*'Attachments',\s*id:\s*'settings-nav-attachments'/);
  assert.equal(source.includes('settingsNavCollapsed'), false);
  assert.equal(source.includes('aria-expanded'), false);
});

test('settings app routes include nested subpages with /settings redirecting to default section', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  assert.equal(source.includes("const DEFAULT_SETTINGS_SUBPAGE = 'ai';"), true);
  assert.equal(source.includes('<Route path="/settings" element={<SettingsLayout />}>'), true);
  assert.equal(source.includes('<Route index element={<Navigate to={DEFAULT_SETTINGS_SUBPAGE} replace />} />'), true);
  assert.equal(source.includes('<Route path="general" element={<SettingsGeneralPage />} />'), true);
  assert.equal(source.includes('<Route path="ai" element={<SettingsAIPage />} />'), true);
  assert.equal(source.includes('<Route path="attachments" element={<SettingsAttachmentsPage />} />'), true);
  assert.equal(source.includes('<Route path="*" element={<Navigate to={DEFAULT_SETTINGS_SUBPAGE} replace />} />'), true);
});
