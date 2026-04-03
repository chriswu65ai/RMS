export const EMPTY_NOTE_TYPE_PLACEHOLDER = '—';

export function getInitialTaskNoteType(noteTypes: string[]): string {
  return noteTypes[0] ?? '';
}

export function getNoteTypeSelectOptions(noteTypes: string[]): string[] {
  return noteTypes.length > 0 ? noteTypes : [''];
}

export function getCreateNoteType(taskNoteType: string, noteTypes: string[]): string {
  return (taskNoteType || noteTypes[0] || 'Research').trim();
}
