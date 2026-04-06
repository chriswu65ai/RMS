export type AttachmentMutationCoordinator = {
  nextToken: () => number;
  isLatest: (token: number) => boolean;
};

export function createAttachmentMutationCoordinator(): AttachmentMutationCoordinator {
  let latestToken = 0;
  return {
    nextToken: () => {
      latestToken += 1;
      return latestToken;
    },
    isLatest: (token: number) => token === latestToken,
  };
}
