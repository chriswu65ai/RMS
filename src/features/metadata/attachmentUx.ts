import type { IngestionDiagnostics, IngestionDiagnosticReason } from '../../lib/agentApi';
import type { Attachment } from '../../types/models';

export const ATTACHMENT_STATUS_LABELS = {
  pending: 'Not ingested: pending parse',
  unsupported: 'Not ingested: unsupported type',
  budgetExceeded: 'Not ingested: budget exceeded',
} as const;

export const getAttachmentDiagnosticReasonMap = (
  diagnostics: IngestionDiagnostics | null | undefined,
): Record<string, IngestionDiagnosticReason> => {
  if (!diagnostics) return {};
  const byAttachmentId: Record<string, IngestionDiagnosticReason> = {};
  diagnostics.files.forEach((file) => {
    if (!file.attachment_id) return;
    byAttachmentId[file.attachment_id] = file.reason;
  });
  return byAttachmentId;
};

export const getAttachmentStatusBadgeLabel = (
  attachment: Attachment,
  diagnosticReason?: IngestionDiagnosticReason,
): string | null => {
  if (diagnosticReason === 'budget_exceeded') return ATTACHMENT_STATUS_LABELS.budgetExceeded;
  if (diagnosticReason === 'parse_pending' || attachment.parse_status === 'pending') return ATTACHMENT_STATUS_LABELS.pending;
  if (
    diagnosticReason === 'unsupported_type'
    || diagnosticReason === 'parse_failed'
    || attachment.parse_status === 'failed'
  ) {
    return ATTACHMENT_STATUS_LABELS.unsupported;
  }
  return null;
};
