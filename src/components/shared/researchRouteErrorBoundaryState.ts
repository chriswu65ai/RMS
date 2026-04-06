export type ResearchRouteBoundaryState = {
  hasError: boolean;
};

export const shouldResetResearchRouteBoundary = (previousResetKey?: string, nextResetKey?: string) =>
  previousResetKey !== nextResetKey;

export const clearedResearchRouteBoundaryState = (): ResearchRouteBoundaryState => ({ hasError: false });
