import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';

export const spellcheckExtension = EditorView.contentAttributes.of({
  spellcheck: 'true',
  autocorrect: 'on',
  autocapitalize: 'sentences',
});

export const editorExtensions = [markdown({ extensions: [{ remove: ['SetextHeading'] }] }), spellcheckExtension];

export function shouldRenderEditableEditor(editorTab: 'edit' | 'split' | 'preview'): boolean {
  return editorTab !== 'preview';
}
