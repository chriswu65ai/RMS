import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('settings shell navigation is always expanded and links to all settings subpages', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/settings/SettingsLayout.tsx'), 'utf-8');
  assert.equal(source.includes('aria-label="Settings sections"'), true);
  assert.match(source, /to:\s*'general',\s*label:\s*'General',\s*id:\s*'settings-nav-general'/);
  assert.match(source, /to:\s*'ai',\s*label:\s*'AI',\s*id:\s*'settings-nav-ai'/);
  assert.match(source, /to:\s*'attachments',\s*label:\s*'Attachments',\s*id:\s*'settings-nav-attachments'/);
  assert.match(source, /to:\s*'system-log',\s*label:\s*'System Log',\s*id:\s*'settings-nav-system-log'/);
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
  assert.equal(source.includes('<Route path="system-log" element={<SettingsSystemLogPage />} />'), true);
  assert.equal(source.includes('<Route path="*" element={<Navigate to={DEFAULT_SETTINGS_SUBPAGE} replace />} />'), true);
});


test('legacy /agent route remains backward compatible via lightweight migration redirect screen', () => {
  const appSource = readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const legacySource = readFileSync(path.resolve(process.cwd(), 'src/features/agent/LegacyAgentRoute.tsx'), 'utf-8');

  assert.equal(appSource.includes("import { LegacyAgentRoute } from './features/agent/LegacyAgentRoute';"), true);
  assert.equal(appSource.includes('<Route path="/agent" element={<LegacyAgentRoute />} />'), true);
  assert.equal(legacySource.includes("navigate('/settings/ai', { replace: true });"), true);
  assert.equal(legacySource.includes('AI configuration has moved to <strong>Settings → AI</strong>. Redirecting now…'), true);
});

test('system log settings page includes filtering, pagination, and export controls', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/settings/SettingsSystemLogPage.tsx'), 'utf-8');
  assert.equal(source.includes('Filter by level'), true);
  assert.equal(source.includes('Filter by text'), true);
  assert.equal(source.includes('From ISO time'), true);
  assert.equal(source.includes('To ISO time'), true);
  assert.equal(source.includes('Download'), true);
  assert.equal(source.includes('Load older'), true);
});
