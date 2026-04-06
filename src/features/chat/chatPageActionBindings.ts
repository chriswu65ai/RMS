import type { ChatStore } from '../../hooks/useChatStore';

type ChatPageStoreActions = Pick<
ChatStore,
'sendMessage' | 'retryMessage' | 'cancelActive' | 'clearError' | 'loadOlderMessages' | 'clearHistory' | 'resetContext' | 'exportSession'
>;

export const createChatPageActionBindings = (actions: ChatPageStoreActions) => ({
  sendMessage: (prompt: string) => actions.sendMessage(prompt),
  retryMessage: (messageId: string) => actions.retryMessage(messageId),
  cancelActive: () => actions.cancelActive(),
  dismissError: () => actions.clearError(),
  loadOlderMessages: () => actions.loadOlderMessages(),
  clearHistory: () => actions.clearHistory('all'),
  resetContext: () => actions.resetContext(),
  exportJson: () => actions.exportSession('json'),
  exportMarkdown: () => actions.exportSession('markdown'),
});
