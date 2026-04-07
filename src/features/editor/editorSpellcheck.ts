import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';

export const spellcheckExtension = EditorView.contentAttributes.of({
  spellcheck: 'false',
  autocorrect: 'off',
  autocapitalize: 'off',
});

export const editorExtensions = [
  markdown({ extensions: [{ remove: ['SetextHeading'] }] }),
  EditorView.lineWrapping,
  spellcheckExtension,
];

export function shouldRenderEditableEditor(editorTab: 'edit' | 'split' | 'preview'): boolean {
  return editorTab !== 'preview';
}
