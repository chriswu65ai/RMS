export const CHAT_OVERLAY_CONTAINER_TEST_ID = 'chat-overlay-controls';
export const JUMP_TO_LATEST_OVERLAY_CLASS = 'pointer-events-none absolute inset-x-0 bottom-28 z-10 flex justify-center';
export const KEYBOARD_RECONCILE_DELAY_MS = 140;
export const BOTTOM_LOCK_THRESHOLD = 80;

export const shouldShowJumpToLatest = (autoScrollLocked: boolean, messageCount: number) => !autoScrollLocked && messageCount > 0;

export const isNearBottom = (node: HTMLElement, threshold = BOTTOM_LOCK_THRESHOLD) => {
  const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
  return distanceFromBottom < threshold;
};

export const computeKeyboardInset = (innerHeight: number, visualViewportHeight: number, visualViewportOffsetTop: number) => {
  return Math.max(0, Math.round(innerHeight - visualViewportHeight - visualViewportOffsetTop));
};

export const shouldRestoreBottomAnchor = (wasAtBottomBeforeKeyboard: boolean, autoScrollLocked: boolean) => (
  wasAtBottomBeforeKeyboard && autoScrollLocked
);
