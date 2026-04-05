export type FileNameCollisionCandidate = {
  name: string;
  folder_id: string | null;
};

const MARKDOWN_EXTENSION = '.md';

const buildMarkdownName = (baseName: string, suffix?: number) => (
  suffix === undefined
    ? `${baseName}${MARKDOWN_EXTENSION}`
    : `${baseName} [${suffix}]${MARKDOWN_EXTENSION}`
);

export const resolveUniqueMarkdownFileName = (
  baseName: string,
  files: FileNameCollisionCandidate[],
  folderId: string | null,
): string => {
  const namesInFolder = new Set(
    files
      .filter((file) => file.folder_id === folderId)
      .map((file) => file.name),
  );

  const firstCandidate = buildMarkdownName(baseName);
  if (!namesInFolder.has(firstCandidate)) return firstCandidate;

  let suffix = 1;
  while (namesInFolder.has(buildMarkdownName(baseName, suffix))) {
    suffix += 1;
  }

  return buildMarkdownName(baseName, suffix);
};
