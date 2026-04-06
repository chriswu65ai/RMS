import test from 'node:test';
import assert from 'node:assert/strict';
import { ATTACHMENT_STATUS_LABELS, getAttachmentDiagnosticReasonMap, getAttachmentStatusBadgeLabel } from './attachmentUx.js';

const baseAttachment = {
  id: 'a1',
  workspace_id: 'w1',
  storage_relpath: 'w1/a1.txt',
  original_name: 'a1.txt',
  mime_type: 'text/plain',
  extension: 'txt',
  size_bytes: 100,
  sha256: 'hash',
  estimated_tokens: 25,
  parse_status: 'parsed' as const,
  parsed_text: 'hello',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
};

test('attachment status badge maps parse states to plain-language copy', () => {
  assert.equal(
    getAttachmentStatusBadgeLabel({ ...baseAttachment, parse_status: 'pending' }),
    ATTACHMENT_STATUS_LABELS.pending,
  );
  assert.equal(
    getAttachmentStatusBadgeLabel({ ...baseAttachment, parse_status: 'failed' }),
    ATTACHMENT_STATUS_LABELS.unsupported,
  );
  assert.equal(
    getAttachmentStatusBadgeLabel(baseAttachment),
    null,
  );
});

test('attachment status badge prefers budget-exceeded diagnostics when available', () => {
  assert.equal(
    getAttachmentStatusBadgeLabel(baseAttachment, 'budget_exceeded'),
    ATTACHMENT_STATUS_LABELS.budgetExceeded,
  );
  assert.equal(
    getAttachmentStatusBadgeLabel(baseAttachment, 'parse_pending'),
    ATTACHMENT_STATUS_LABELS.pending,
  );
  assert.equal(
    getAttachmentStatusBadgeLabel(baseAttachment, 'unsupported_type'),
    ATTACHMENT_STATUS_LABELS.unsupported,
  );
});

test('diagnostics reason map indexes by attachment id', () => {
  const map = getAttachmentDiagnosticReasonMap({
    total_eligible_attachments: 2,
    fully_included_attachments: 0,
    partially_included_attachments: 1,
    excluded_attachments: 1,
    token_budget: 2000,
    tokens_consumed: 1900,
    files: [
      {
        attachment_id: 'a1',
        filename: 'a1.txt',
        reason: 'budget_exceeded',
        included_tokens: 100,
        estimated_tokens: 500,
        fully_included: false,
        partially_included: true,
      },
      {
        attachment_id: 'a2',
        filename: 'a2.txt',
        reason: 'parse_pending',
        included_tokens: 0,
        estimated_tokens: 120,
        fully_included: false,
        partially_included: false,
      },
    ],
  });

  assert.deepEqual(map, {
    a1: 'budget_exceeded',
    a2: 'parse_pending',
  });
});
