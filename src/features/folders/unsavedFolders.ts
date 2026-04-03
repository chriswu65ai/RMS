import type { Folder, ResearchNote } from '../../types/models';

export const deriveFoldersWithUnsavedFiles = (folders: Folder[], files: ResearchNote[], unsavedFileIds: string[]) => {
  const folderById = new Map(folders.map((folder) => [folder.id, folder] as const));
  const unsavedSet = new Set(unsavedFileIds);
  const foldersWithUnsaved = new Set<string>();

  files.forEach((file) => {
    if (!file.folder_id || !unsavedSet.has(file.id)) return;

    let currentFolderId: string | null = file.folder_id;
    while (currentFolderId) {
      foldersWithUnsaved.add(currentFolderId);
      currentFolderId = folderById.get(currentFolderId)?.parent_id ?? null;
    }
  });

  return foldersWithUnsaved;
};
