import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentMutationCoordinator } from './attachmentMutationCoordinator.js';

test('overlapping attachment mutations only apply the latest response', async () => {
  const coordinator = createAttachmentMutationCoordinator();
  const applied: string[] = [];

  const runMutation = async (label: string, delayMs: number) => {
    const token = coordinator.nextToken();
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    if (!coordinator.isLatest(token)) return;
    applied.push(label);
  };

  await Promise.all([
    runMutation('older-remove-response', 20),
    runMutation('newer-upload-response', 5),
  ]);

  assert.deepEqual(applied, ['newer-upload-response']);
});
