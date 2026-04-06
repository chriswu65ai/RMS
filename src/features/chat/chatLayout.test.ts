import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CHAT_OVERLAY_CONTAINER_TEST_ID,
  JUMP_TO_LATEST_OVERLAY_CLASS,
  computeKeyboardInset,
  shouldRestoreBottomAnchor,
  shouldShowJumpToLatest,
} from './chatLayout.js';

test('jump button visibility logic only enables when chat is unlocked with messages', () => {
  assert.equal(shouldShowJumpToLatest(true, 3), false);
  assert.equal(shouldShowJumpToLatest(false, 0), false);
  assert.equal(shouldShowJumpToLatest(false, 2), true);
});

test('chat page keeps jump control inside the dedicated overlay container anchored to the chat section', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/features/chat/ChatPage.tsx'), 'utf8');

  assert.match(source, /<section className="relative flex h-full min-h-0 flex-col bg-slate-50">/);
  assert.match(source, /data-testid=\{CHAT_OVERLAY_CONTAINER_TEST_ID\}/);
  assert.match(source, /className=\{JUMP_TO_LATEST_OVERLAY_CLASS\}/);

  const overlayCallIndex = source.indexOf('<JumpToLatestOverlay');
  const composerContainerIndex = source.indexOf('className="sticky bottom-0 z-20"');
  assert.ok(overlayCallIndex >= 0 && composerContainerIndex > overlayCallIndex, 'overlay should render within ChatPage before composer');
});

test('keyboard inset uses visual viewport deltas and never goes negative', () => {
  assert.equal(computeKeyboardInset(800, 600, 0), 200);
  assert.equal(computeKeyboardInset(800, 780, 20), 0);
  assert.equal(computeKeyboardInset(800, 790, 30), 0);
});

test('bottom anchor restore only runs for preserved-bottom users', () => {
  assert.equal(shouldRestoreBottomAnchor(true, true), true);
  assert.equal(shouldRestoreBottomAnchor(true, false), false);
  assert.equal(shouldRestoreBottomAnchor(false, true), false);
});
