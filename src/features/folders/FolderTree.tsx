import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText, FolderPlus, PanelLeftClose, PanelLeftOpen, Pencil, Tag, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { createFolder, deleteFolder, renameFolder } from '../../lib/dataApi';
import { usePromptStore } from '../../hooks/usePromptStore';
import { useDialog } from '../../components/ui/DialogProvider';
import { splitFrontmatter } from '../../lib/frontmatter';

const TYPE_FILTER_ALL = '__ALL_TYPED__';
const TYPE_FILTER_NONE = '__NO_TYPE__';

export function FolderTree({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { folders, selectedFolderId, selectFolder, workspace, files, refresh, selectedTag, selectTag } = usePromptStore();
  const dialog = useDialog();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [typesCollapsed, setTypesCollapsed] = useState(false);

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, typeof folders>();
    const sortedFolders = [...folders].sort((a, b) => a.name.localeCompare(b.name));

    sortedFolders.forEach((folder) => {
      const key = folder.parent_id ?? null;
      const list = map.get(key) ?? [];
      list.push(folder);
      map.set(key, list);
    });

    return map;
  }, [folders]);

  const templatesFolder = useMemo(
    () => folders.find((folder) => folder.parent_id === null && folder.name.trim().toLowerCase() === 'templates') ?? null,
    [folders],
  );

  const expandableFolderIds = useMemo(() => {
    const ids = new Set<string>();
    folders.forEach((folder) => {
      if ((childrenByParent.get(folder.id) ?? []).length > 0) {
        ids.add(folder.id);
      }
    });
    return ids;
  }, [childrenByParent, folders]);

  const allExpanded = useMemo(() => {
    if (expandableFolderIds.size === 0) return true;
    for (const id of expandableFolderIds) {
      if (collapsedIds.has(id)) return false;
    }
    return true;
  }, [collapsedIds, expandableFolderIds]);

  const noteTypes = useMemo(() => {
    const map = new Map<string, number>();
    files.forEach((file) => {
      const parsed = splitFrontmatter(file.content);
      const type = parsed.frontmatter.type?.toString().trim();
      if (!type) return;
      map.set(type, (map.get(type) ?? 0) + 1);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  const toggleFolderExpanded = (folderId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const toggleAllSubfolders = () => {
    setCollapsedIds((prev) => {
      const hasExpanded = [...expandableFolderIds].some((id) => !prev.has(id));
      return hasExpanded ? new Set(expandableFolderIds) : new Set();
    });
  };


  const getFolderLabel = (folder: (typeof folders)[number]) => {
    const name = folder.name?.trim();
    if (name && !name.includes('/')) return name;
    const parts = folder.path.split('/').filter(Boolean);
    const fromPath = parts[parts.length - 1];
    return fromPath || folder.name || folder.path;
  };


  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center py-2">
        <button
          className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
          onClick={onToggleCollapsed}
          aria-label="Expand folders panel"
          title="Expand folders panel"
        >
          <PanelLeftOpen size={16} />
        </button>
      </div>
    );
  }

  const renderFolderNode = (folder: (typeof folders)[number], depth: number) => {
    const childFolders = childrenByParent.get(folder.id) ?? [];
    const hasChildren = childFolders.length > 0;
    const isCollapsed = collapsedIds.has(folder.id);
    const isExpanded = hasChildren && !isCollapsed;
    const count = files.filter((f) => f.folder_id === folder.id).length;
    const isTemplatesFolder = Boolean(templatesFolder && templatesFolder.id === folder.id);
    const selectedStyle = selectedFolderId === folder.id ? 'bg-slate-900 text-white' : 'hover:bg-slate-100';
    const showChevron = hasChildren && !isTemplatesFolder;

    return (
      <div key={folder.id}>
        <div className="group flex items-center gap-1" style={{ paddingLeft: `${depth * 14}px` }}>
          {showChevron ? (
            <button
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100"
              onClick={() => toggleFolderExpanded(folder.id)}
              aria-label={isExpanded ? `Collapse ${getFolderLabel(folder)}` : `Expand ${getFolderLabel(folder)}`}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : null}
          <button className={`flex flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${isTemplatesFolder ? `w-full pl-3 font-semibold ${selectedStyle}` : selectedStyle}`} onClick={() => selectFolder(folder.id)}>
            {isTemplatesFolder && (
              <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center opacity-80">
                <FileText size={14} />
                <span className="absolute -bottom-1 -right-1 inline-flex h-3 min-w-3 items-center justify-center rounded-full bg-slate-700 px-0.5 text-[8px] font-bold leading-none text-white">T</span>
              </span>
            )}
            <span>
              {getFolderLabel(folder)}
              {!isTemplatesFolder && <span className="text-xs opacity-70"> ({count})</span>}
            </span>
          </button>
          <div className={`items-center gap-1 ${isTemplatesFolder ? 'hidden' : 'hidden group-hover:flex'}`}>
            <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={async () => {
              const name = await dialog.prompt('Rename folder', getFolderLabel(folder), 'New folder name');
              if (!name) return;
              const newPath = folder.parent_id ? `${folders.find((f) => f.id === folder.parent_id)?.path}/${name}` : name;
              const { error } = await renameFolder(folder.id, name, newPath);
              if (error) return dialog.alert('Rename failed', error.message);
              await refresh();
            }}><Pencil size={14} /></button>
            <button
              className="rounded p-1 text-slate-500 hover:bg-slate-100"
              onClick={async () => {
                if (files.some((f) => f.folder_id === folder.id)) return dialog.alert('Folder not empty', 'Delete files in this folder first.');
                if (!(await dialog.confirm('Delete folder', `Delete folder ${getFolderLabel(folder)}?`))) return;
                await deleteFolder(folder.id);
                await refresh();
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {isExpanded && (
          <div className="space-y-1">
            {childFolders.map((child) => renderFolderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between py-2 pl-3 pr-4">
        <div className="flex items-center gap-1">
          <button
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
            onClick={onToggleCollapsed}
            aria-label="Collapse folders panel"
            title="Collapse folders panel"
          >
            <PanelLeftClose size={16} />
          </button>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Folders</h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="rounded-md p-1 text-slate-600 hover:bg-slate-100"
            title="Create new folder"
            aria-label="Create new folder"
            onClick={async () => {
              if (!workspace) return;
              const parent = folders.find((f) => f.id === selectedFolderId) ?? null;
              const name = await dialog.prompt('Create folder', '', `Folder name${parent ? ` (${parent.path}/...)` : ''}`);
              if (!name) return;
              const duplicate = folders.some((f) => f.path === `${parent?.path ? `${parent.path}/` : ''}${name}`);
              if (duplicate) return dialog.alert('Duplicate folder', 'Folder already exists.');
              await createFolder(workspace.id, name, parent);
              await refresh();
            }}
          >
            <FolderPlus size={16} />
          </button>
          <button
            className="rounded-md p-1 text-slate-600 hover:bg-slate-100"
            title={allExpanded ? 'Hide all sub-folders' : 'Expand all sub-folders'}
            onClick={toggleAllSubfolders}
            aria-label={allExpanded ? 'Hide all sub-folders' : 'Expand all sub-folders'}
          >
            {allExpanded ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
          </button>
        </div>
      </div>
      <button className={`mx-2 flex items-center gap-2 rounded-lg py-2 pl-3 pr-3 text-left text-sm font-semibold ${selectedFolderId === null ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`} onClick={() => selectFolder(null)}>
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <FileText size={14} />
        </span>
        <span>All notes</span>
      </button>
      {templatesFolder && (
        <div className="px-2 pb-1 pt-1">
          {renderFolderNode(templatesFolder, 0)}
        </div>
      )}
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {(childrenByParent.get(null) ?? []).filter((folder) => !templatesFolder || folder.id !== templatesFolder.id).map((folder) => renderFolderNode(folder, 0))}
      </div>

      <div className="shrink-0 border-t border-slate-200 p-2">
        <div className="mb-2 flex items-center justify-between px-2">
          <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><Tag size={12} />Note types</h4>
          <button
            className="rounded-md p-1 text-slate-600 hover:bg-slate-100"
            title={typesCollapsed ? 'Expand note types' : 'Hide note types'}
            aria-label={typesCollapsed ? 'Expand note types' : 'Hide note types'}
            onClick={() => setTypesCollapsed((prev) => !prev)}
          >
            {typesCollapsed ? <ChevronsUpDown size={16} /> : <ChevronsDownUp size={16} />}
          </button>
        </div>

        {!typesCollapsed && (
          <div className="max-h-48 overflow-y-auto">
            <button
              className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-sm ${selectedTag === TYPE_FILTER_ALL ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
              onClick={() => selectTag(TYPE_FILTER_ALL)}
            >
              All note types
            </button>
            <button
              className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-sm ${selectedTag === TYPE_FILTER_NONE ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
              onClick={() => selectTag(TYPE_FILTER_NONE)}
            >
              No note type
            </button>
            <div className="space-y-1">
              {noteTypes.map(([tag, count]) => (
                <button
                  key={tag}
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selectedTag === tag ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
                  onClick={() => selectTag(tag)}
                >
                  {tag} <span className="text-xs opacity-70">({count})</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
