import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatSettingsPolicy, resolveChatRuntimeSettings } from './chatRuntimeSettingsResolver.js';

test('resolveChatRuntimeSettings applies explicit request overrides before policy and agent defaults', () => {
  const normalizedPolicy = normalizeChatSettingsPolicy({
    action_mode: 'assist',
    ask_when_missing: true,
    command_prefix_mode: 'off',
    detailed_tool_steps: false,
    web_search_enabled: false,
  });

  const resolved = resolveChatRuntimeSettings({
    normalizedPolicy,
    requestBody: {
      action_mode: 'manual_only',
      ask_when_missing: false,
      command_prefix_mode: 'on',
      detailed_tool_steps: true,
      web_search_enabled: true,
    },
    agentGenerationParams: { web_search: { enabled: false } },
  });

  assert.deepEqual(resolved, {
    actionMode: 'manual_only',
    askWhenInfoMissing: false,
    commandPrefixMode: 'on',
    commandPrefixMap: normalizedPolicy.commandPrefixMap,
    toolTraceVisibility: 'detailed',
    webSearchEnabled: true,
  });
});

test('resolveChatRuntimeSettings falls back from request to policy to agent setting deterministically', () => {
  const normalizedPolicy = normalizeChatSettingsPolicy({
    action_mode: 'act',
    ask_when_missing: false,
    command_prefix_mode: 'on',
    detailed_tool_steps: false,
  });

  const resolved = resolveChatRuntimeSettings({
    normalizedPolicy,
    requestBody: {},
    agentGenerationParams: { web_search: { enabled: true } },
  });

  assert.equal(resolved.actionMode, 'confirm_required');
  assert.equal(resolved.askWhenInfoMissing, false);
  assert.equal(resolved.commandPrefixMode, 'on');
  assert.equal(resolved.toolTraceVisibility, 'summary');
  assert.equal(resolved.webSearchEnabled, true);
});

test('normalizeChatSettingsPolicy canonicalizes legacy action mode values', () => {
  const normalized = normalizeChatSettingsPolicy({ action_mode: 'act' });
  assert.equal(normalized.actionMode, 'confirm_required');
  assert.equal(normalized.policy.action_mode, 'confirm_required');
});
