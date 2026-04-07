import type { NewResearchTaskInput } from '../../types/models';

type ModalState = { mode: 'create' | 'edit'; task: NewResearchTaskInput; id?: string };

export const CREATE_TASK_MODAL_OPEN_KEY = '__create_task_modal__';

export const getModalOpenStateKey = (state: ModalState | null): string | null => (
  state ? (state.id ?? CREATE_TASK_MODAL_OPEN_KEY) : null
);
