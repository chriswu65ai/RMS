export const CHAT_OVERLAY_CONTAINER_TEST_ID = 'chat-overlay-controls';
export const JUMP_TO_LATEST_OVERLAY_CLASS = 'pointer-events-none absolute inset-x-0 bottom-28 z-10 flex justify-center';

export const shouldShowJumpToLatest = (autoScrollLocked: boolean, messageCount: number) => !autoScrollLocked && messageCount > 0;
