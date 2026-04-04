import type { AgentActivityLog } from './types';

export const getWebSearchWarningBannerMessage = (activity: AgentActivityLog[], webSearchEnabled: boolean) => {
  if (!webSearchEnabled) return '';
  const latestSearchWarning = activity.find((entry) => entry.search_warning === 1);
  if (!latestSearchWarning) return '';
  if (latestSearchWarning.search_warning_message?.trim()) {
    return `Web search is enabled, but recent runs reported search warnings: ${latestSearchWarning.search_warning_message}`;
  }
  return 'Web search is enabled, but recent runs reported search warnings.';
};
