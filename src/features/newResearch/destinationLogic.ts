import type { Folder, NewResearchTask, NewResearchTaskInput } from '../../types/models';

export type DestinationPreview = {
  destinationPath: string;
  fallbackPath: string;
  missingFolderName: string;
  needsFolderCreation: boolean;
  manualDestinationLocked: boolean;
  selectedFolder: Folder | null;
  ticker: string;
  tickerFolder: Folder | null;
};

export const findTickerFolderForTicker = (ticker: string, availableFolders: Folder[]) => {
  const normalizedTicker = ticker.trim().toUpperCase();
  if (!normalizedTicker) return null;
  return availableFolders.find((folder) => {
    const name = folder.name.trim().toUpperCase();
    const path = folder.path.trim().toUpperCase();
    return name === normalizedTicker || path === normalizedTicker || path.endsWith(`/${normalizedTicker}`);
  }) ?? null;
};

export const isManualResearchLocationSelection = (task: Pick<NewResearchTaskInput, 'ticker' | 'research_location_folder_id'>, availableFolders: Folder[]) => {
  if (!task.research_location_folder_id?.trim()) return false;
  const tickerFolder = findTickerFolderForTicker(task.ticker, availableFolders);
  return task.research_location_folder_id !== (tickerFolder?.id ?? '');
};

export const applyTickerChangeToTask = (task: NewResearchTaskInput, rawTicker: string, availableFolders: Folder[]) => {
  const ticker = rawTicker.toUpperCase();
  const manualDestinationLocked = isManualResearchLocationSelection(task, availableFolders);
  const matchedFolder = findTickerFolderForTicker(ticker, availableFolders);
  if (manualDestinationLocked) {
    return {
      ...task,
      ticker,
    };
  }
  return {
    ...task,
    ticker,
    research_location_folder_id: matchedFolder?.id ?? '',
    research_location_path: matchedFolder?.path ?? '',
  };
};

export const resolveDestinationPreviewForTask = (task: NewResearchTaskInput | NewResearchTask, availableFolders: Folder[]): DestinationPreview => {
  const ticker = task.ticker.trim().toUpperCase();
  const researchLocationPath = (task.research_location_path ?? '').trim();
  const selectedFolder = task.research_location_folder_id
    ? (availableFolders.find((folder) => folder.id === task.research_location_folder_id) ?? null)
    : (researchLocationPath ? (availableFolders.find((folder) => folder.path === researchLocationPath) ?? null) : null);
  const tickerFolder = findTickerFolderForTicker(ticker, availableFolders);
  const fallbackPath = ticker || 'Root';
  const manualDestinationLocked = isManualResearchLocationSelection(task, availableFolders);

  const explicitPath = researchLocationPath;
  const explicitFolderMissing = Boolean(explicitPath && !selectedFolder);

  const destinationPath = selectedFolder?.path
    ?? (explicitFolderMissing ? explicitPath : (tickerFolder?.path ?? fallbackPath));
  const needsFolderCreation = explicitFolderMissing || Boolean(!selectedFolder && ticker && !tickerFolder);
  const missingFolderName = explicitFolderMissing ? explicitPath : (ticker || '');

  return {
    fallbackPath,
    destinationPath,
    needsFolderCreation,
    missingFolderName,
    manualDestinationLocked,
    ticker,
    selectedFolder,
    tickerFolder,
  };
};
