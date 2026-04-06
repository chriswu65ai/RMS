import type { SearchResult } from '../searchProviders';

export type WebGenerationSource = {
  kind: 'web';
  title: string;
  url: string;
  snippet: string;
  provider: string;
  published_at?: string;
};

export type AttachmentGenerationSource = {
  kind: 'attachment';
  attachment_id: string;
  label: string;
};

export type GenerationSource = WebGenerationSource | AttachmentGenerationSource;

export const toWebGenerationSource = (source: SearchResult): WebGenerationSource => ({
  kind: 'web',
  title: source.title,
  url: source.url,
  snippet: source.snippet,
  provider: source.provider,
  ...(source.published_at ? { published_at: source.published_at } : {}),
});

export const toAttachmentGenerationSource = (attachment: { id: string; original_name: string }): AttachmentGenerationSource => ({
  kind: 'attachment',
  attachment_id: attachment.id,
  label: attachment.original_name,
});

