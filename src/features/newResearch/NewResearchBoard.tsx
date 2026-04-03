import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Folder, FrontmatterModel, NewResearchTask, NewResearchTaskInput } from '../../types/models';
import { Priority, TaskStatus } from '../../types/models';
import { createFile, createFolder, createNewResearchTask, deleteNewResearchTask, listNewResearchTasks, listTaskActivity, updateNewResearchTask } from '../../lib/dataApi';
import { buildCanonicalStockFileName, toLocalDateInputValue, usePromptStore } from '../../hooks/usePromptStore';
import { composeMarkdown, splitFrontmatter } from '../../lib/frontmatter';
import { PageState } from '../../components/shared/PageState';
import { useDialog } from '../../components/ui/DialogProvider';

const COLUMNS: Array<{ key: TaskStatus; label: string }> = [
  { key: TaskStatus.Ideas, label: 'Ideas' },
  { key: TaskStatus.Researching, label: 'In Progress' },
  { key: TaskStatus.Completed, label: 'Completed' },
];

const PRIORITY_LABEL: Record<Priority, string> = {
  [Priority.High]: 'High',
  [Priority.Medium]: 'Medium',
  [Priority.Low]: 'Low',
};

const PRIORITY_STYLE: Record<Priority, string> = {
  [Priority.High]: 'bg-rose-100 text-rose-700 border-rose-200',
  [Priority.Medium]: 'bg-amber-100 text-amber-700 border-amber-200',
  [Priority.Low]: 'bg-emerald-100 text-emerald-700 border-emerald-200',
};
const PRIORITY_RANK: Record<Priority | '', number> = {
  [Priority.High]: 0,
  [Priority.Medium]: 1,
  [Priority.Low]: 2,
  '': 3,
};

type ModalState = { mode: 'create' | 'edit'; task: NewResearchTaskInput; id?: string };

const blankTask = (): NewResearchTaskInput => ({
  topic: '', details: '', ticker: '', note_type: 'Research', assignee: '', priority: '', deadline: '', status: TaskStatus.Ideas,
  date_completed: '', archived: false, linked_note_file_id: '', linked_note_path: '', research_location_folder_id: '', research_location_path: '',
});

const todayDate = () => new Date().toISOString().slice(0, 10);
const stripExtension = (value: string) => value.replace(/\.[^/.]+$/, '');

export function NewResearchBoard({ assignees, noteTypes }: { assignees: string[]; noteTypes: string[] }) {
  const navigate = useNavigate();
  const dialog = useDialog();
  const { workspace, folders, files, refresh, transitionTaskModal, transitionTaskToNote, selectedTaskId } = usePromptStore();
  const [tasks, setTasks] = useState<NewResearchTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [modalState, setModalState] = useState<ModalState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityItems, setActivityItems] = useState<Array<{ id: string; description: string; created_at: string }>>([]);
  const taskByLinkedFileId = useMemo(() => {
    const byLinkedFile = new Map<string, NewResearchTask>();
    tasks.forEach((task) => {
      if (!task.linked_note_file_id) return;
      byLinkedFile.set(task.linked_note_file_id, task);
    });
    return byLinkedFile;
  }, [tasks]);

  const visibleTasks = useMemo(() => tasks.filter((task) => showArchived || !task.archived), [showArchived, tasks]);
  const prioritizedTasks = useMemo(
    () => [...visibleTasks].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]),
    [visibleTasks],
  );
  const findTickerFolder = (ticker: string, availableFolders: Folder[]) => {
    const normalizedTicker = ticker.trim().toUpperCase();
    if (!normalizedTicker) return null;
    return availableFolders.find((folder) => {
      const name = folder.name.trim().toUpperCase();
      const path = folder.path.trim().toUpperCase();
      return name === normalizedTicker || path === normalizedTicker || path.endsWith(`/${normalizedTicker}`);
    }) ?? null;
  };
  const matchingTemplateForType = (typeValue: string) => {
    const target = typeValue.trim().toLowerCase();
    if (!target) return null;
    return files.find((file) => {
      if (!file.is_template) return false;
      if (!file.path.toLowerCase().includes('template')) return false;
      return stripExtension(file.name).trim().toLowerCase() === target;
    }) ?? null;
  };

  const resolveDestinationPreview = (task: NewResearchTaskInput | NewResearchTask) => {
    const ticker = task.ticker.trim().toUpperCase();
    const researchLocationPath = (task.research_location_path ?? '').trim();
    const selectedFolder = task.research_location_folder_id
      ? (folders.find((folder) => folder.id === task.research_location_folder_id) ?? null)
      : (researchLocationPath ? (folders.find((folder) => folder.path === researchLocationPath) ?? null) : null);
    const tickerFolder = findTickerFolder(ticker, folders);
    const fallbackPath = ticker || 'Root';

    const explicitPath = researchLocationPath;
    const explicitFolderMissing = Boolean(explicitPath && !selectedFolder);

    const destinationPath = selectedFolder?.path
      ?? (explicitFolderMissing ? explicitPath : (tickerFolder?.path ?? fallbackPath));
    const needsFolderCreation = explicitFolderMissing || Boolean(!selectedFolder && ticker && !tickerFolder);
    const missingFolderName = explicitFolderMissing ? explicitPath : (ticker || '');

    return {
      selectedPath: selectedFolder?.path || explicitPath || 'Auto (ticker/default)',
      fallbackPath,
      destinationPath,
      needsFolderCreation,
      missingFolderName,
      explicitFolderMissing,
      ticker,
      selectedFolder,
      tickerFolder,
    };
  };

  const loadTasks = async () => {
    setLoading(true);
    setError(null);
    try { setTasks(await listNewResearchTasks()); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load new research tasks.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void loadTasks(); }, []);

  useEffect(() => {
    if (!selectedTaskId) return;
    if (selectedTaskId === 'new') {
      setModalState({ mode: 'create', task: { ...blankTask(), note_type: noteTypes[0] ?? 'Research' } });
      setActivityExpanded(false);
      return;
    }
    const selectedTask = tasks.find((task) => task.id === selectedTaskId);
    if (!selectedTask) return;
    if (modalState?.id === selectedTask.id) return;
    setModalState({ mode: 'edit', id: selectedTask.id, task: { ...selectedTask } });
    setActivityExpanded(false);
  }, [selectedTaskId, tasks, noteTypes, modalState?.id]);

  useEffect(() => {
    if (!modalState?.id) {
      setActivityItems([]);
      setActivityError(null);
      setActivityLoading(false);
      return;
    }
    setActivityLoading(true);
    setActivityError(null);
    void (async () => {
      try {
        const events = await listTaskActivity(modalState.id as string);
        setActivityItems(events);
      } catch (err) {
        setActivityError(err instanceof Error ? err.message : 'Failed to load task activity.');
      } finally {
        setActivityLoading(false);
      }
    })();
  }, [modalState?.id]);

  const saveTask = async () => {
    if (!modalState) return;
    if (!modalState.task.ticker.trim()) return setError('Ticker is required.');
    const willAutoComplete = modalState.task.date_completed.trim() && modalState.task.status !== TaskStatus.Completed;
    const payload: NewResearchTaskInput = willAutoComplete
      ? { ...modalState.task, status: TaskStatus.Completed }
      : modalState.task;

    setSaving(true);
    setError(null);
    try {
      if (modalState.mode === 'create') {
        const created = await createNewResearchTask(payload);
        setTasks((prev) => [created, ...prev]);
      } else if (modalState.id) {
        const updated = await updateNewResearchTask(modalState.id, payload);
        setTasks((prev) => prev.map((task) => (task.id === modalState.id ? updated : task)));
      }
      setModalState(null);
      transitionTaskModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task.');
    } finally {
      setSaving(false);
    }
  };

  const moveTask = async (task: NewResearchTask, nextStatus: TaskStatus) => {
    const nextDate = nextStatus === TaskStatus.Completed && !task.date_completed ? todayDate() : (nextStatus === TaskStatus.Completed ? task.date_completed : '');
    try {
      const updated = await updateNewResearchTask(task.id, { ...task, status: nextStatus, date_completed: nextDate });
      setTasks((prev) => prev.map((item) => (item.id === task.id ? updated : item)));
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to move task.'); }
  };

  const toggleArchive = async (task: NewResearchTask) => {
    try {
      const updated = await updateNewResearchTask(task.id, { ...task, archived: !task.archived });
      setTasks((prev) => prev.map((item) => (item.id === task.id ? updated : item)));
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to update archive status.'); }
  };

  const removeTask = async (taskId: string) => {
    const confirmed = await dialog.confirm('Delete task', 'Delete this task permanently?');
    if (!confirmed) return;
    try { await deleteNewResearchTask(taskId); setTasks((prev) => prev.filter((task) => task.id !== taskId)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to delete task.'); }
  };

  const openLinkedNote = (task: NewResearchTask) => {
    const transition = transitionTaskToNote(task);
    if (!transition.ok) return setError(transition.reason ?? 'Linked note is unavailable.');
    navigate('/research.html');
  };

  const createNoteFromTask = async (task: NewResearchTask) => {
    if (!workspace) return setError('Workspace is not ready yet.');
    const preview = resolveDestinationPreview(task);
    const ticker = preview.ticker;
    if (!ticker) return setError('Ticker is required before creating a note.');

    const type = (task.note_type || noteTypes[0] || 'Research').trim();
    const date = toLocalDateInputValue();
    const name = buildCanonicalStockFileName(date, ticker, type);
    let targetFolder = preview.selectedFolder ?? preview.tickerFolder;

    if (preview.needsFolderCreation) {
      const confirmed = await dialog.confirm('Create note from task', `Folder "${preview.destinationPath}" does not exist. It will be created when you create this note. Continue?`);
      if (!confirmed) return;
      const createName = preview.explicitFolderMissing ? preview.destinationPath : ticker;
      const createParent = null;
      const { error: createFolderError } = await createFolder(workspace.id, createName, createParent);
      if (createFolderError) return setError(createFolderError.message);
      await refresh();
      targetFolder = usePromptStore.getState().folders.find((folder) => folder.path === preview.destinationPath) ?? null;
      if (!targetFolder) return setError(`Folder was created at ${preview.destinationPath}, but it could not be found.`);
    }

    const existing = files.find((file) => !file.is_template && file.name === name && file.folder_id === (targetFolder?.id ?? null));

    if (existing) {
      const linkedOwner = taskByLinkedFileId.get(existing.id);
      if (linkedOwner && linkedOwner.id !== task.id) {
        setError(`A different task is already linked to ${existing.path}. Keep task↔note links one-to-one by creating a new note.`);
        return;
      }
      const updatedTask = await updateNewResearchTask(task.id, { ...task, linked_note_file_id: existing.id, linked_note_path: existing.path });
      setTasks((prev) => prev.map((item) => (item.id === task.id ? updatedTask : item)));
      openLinkedNote(updatedTask);
      return;
    }

    const taskContext = task.details || task.topic || '-';
    const template = matchingTemplateForType(type);
    const noteTitle = task.topic.trim() || `${ticker} ${type}`;
    const taskContextBlock = `### Task context\n${taskContext}\n`;
    const frontmatter: FrontmatterModel = template
      ? { ...splitFrontmatter(template.content).frontmatter, template: false, title: noteTitle, ticker, type, date }
      : { title: noteTitle, ticker, type, date, recommendation: '' };
    const templateBody = template ? splitFrontmatter(template.content).body.trimEnd() : '';
    const body = templateBody ? `${taskContextBlock}\n${templateBody}` : taskContextBlock;
    const content = composeMarkdown(frontmatter, body);
    const result = await createFile({ workspaceId: workspace.id, folderId: targetFolder?.id ?? null, folderPath: targetFolder?.path ?? null, name, content, frontmatter });
    if (result.error) return setError(result.error.message);

    await refresh();
    const created = usePromptStore.getState().files.find((file) => !file.is_template && file.path === `${targetFolder?.path ? `${targetFolder.path}/` : ''}${name}`);
    if (!created) return setError('Note created, but it could not be selected automatically.');

    const updatedTask = await updateNewResearchTask(task.id, { ...task, linked_note_file_id: created.id, linked_note_path: created.path });
    setTasks((prev) => prev.map((item) => (item.id === task.id ? updatedTask : item)));
    const transition = transitionTaskToNote(updatedTask, created.id);
    if (!transition.ok) return setError(transition.reason ?? 'Linked note is unavailable.');
    navigate('/research.html');
  };

  useEffect(() => {
    if (!modalState) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setModalState(null);
      transitionTaskModal(null);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [modalState, transitionTaskModal]);

  const closeModal = () => {
    setModalState(null);
    transitionTaskModal(null);
  };

  const modalDestinationPreview = useMemo(
    () => (modalState ? resolveDestinationPreview(modalState.task) : null),
    [modalState, folders],
  );

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-2 py-1 text-xs text-white" onClick={() => { setModalState({ mode: 'create', task: { ...blankTask(), note_type: noteTypes[0] ?? 'Research' } }); setActivityExpanded(false); transitionTaskModal('new'); }}><Plus size={14} />Add task</button>
        <label className="inline-flex items-center gap-2 text-xs text-slate-600">
          <input
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
          />
          Show archived
        </label>
      </div>

      {error && <PageState kind="error" message={error} />}
      {loading ? <PageState kind="loading" message="Loading board..." /> : (
        <div className="grid gap-4 lg:grid-cols-3">
          {COLUMNS.map((column) => (
            <div key={column.key} className="rounded-xl border border-slate-200 bg-white p-3" onDragOver={(e) => e.preventDefault()} onDrop={async () => {
              if (!draggingId) return;
              const task = tasks.find((item) => item.id === draggingId);
              if (!task || task.status === column.key) return;
              await moveTask(task, column.key);
              setDraggingId(null);
            }}>
              <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold text-slate-800">{column.label}</h3><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{prioritizedTasks.filter((task) => task.status === column.key).length}</span></div>
              <div className="space-y-2">
                {prioritizedTasks.filter((task) => task.status === column.key).map((task) => (
                  <article key={task.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3" draggable onDragStart={() => setDraggingId(task.id)} onDragEnd={() => setDraggingId(null)}>
                    <div className="flex items-start justify-between gap-3">
                      <button className="text-left" onClick={() => { setModalState({ mode: 'edit', id: task.id, task: { ...task } }); setActivityExpanded(false); transitionTaskModal(task.id); }}><p className="font-medium text-slate-900">{task.topic || 'Untitled title'}</p><p className="text-xs font-semibold text-slate-700">{task.ticker}</p></button>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-600">
                      <p>Assignee: {task.assignee || '—'}</p>
                      <p>
                        Priority:{' '}
                        {task.priority
                          ? <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${PRIORITY_STYLE[task.priority]}`}>{PRIORITY_LABEL[task.priority]}</span>
                          : '—'}
                      </p>
                      <p>Deadline: {task.deadline || '—'}</p>
                      <p>Completed: {task.date_completed || '—'}</p>
                      {/* linked_note_file_id remains the open/navigation source of truth; path is display-only metadata */}
                      <p className="col-span-2">Linked note: {task.linked_note_path || '—'}</p>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2"><button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100" onClick={() => void createNoteFromTask(task)}>{task.linked_note_file_id ? 'Reopen note' : 'Create note from task'}</button><div className="flex items-center gap-3"><button className="text-xs text-rose-600" onClick={() => void removeTask(task.id)}>Delete</button><button className="text-xs text-slate-600 hover:text-slate-900" onClick={() => void toggleArchive(task)}>{task.archived ? 'Unarchive' : 'Archive'}</button></div></div>
                  </article>
                ))}
                {prioritizedTasks.filter((task) => task.status === column.key).length === 0 && <PageState kind="empty" message={`No tasks in ${column.label.toLowerCase()}.`} />}
              </div>
            </div>
          ))}
        </div>
      )}

      {modalState && createPortal(
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return;
          closeModal();
        }}>
          <div className="w-full max-w-xl rounded-xl bg-white p-4 shadow-xl" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="text-lg font-semibold">{modalState.mode === 'create' ? 'Create task' : 'Edit task'}</h3>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="text-sm md:col-span-2">Title<input className="input mt-1" value={modalState.task.topic} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, topic: e.target.value } } : prev)} /></label>
              <label className="text-sm">Ticker *<input className="input mt-1" required value={modalState.task.ticker} onChange={(e) => setModalState((prev) => {
                if (!prev) return prev;
                const ticker = e.target.value.toUpperCase();
                const matchedFolder = findTickerFolder(ticker, folders);
                return {
                  ...prev,
                  task: {
                    ...prev.task,
                    ticker,
                    research_location_folder_id: matchedFolder?.id ?? prev.task.research_location_folder_id ?? '',
                    research_location_path: matchedFolder?.path ?? prev.task.research_location_path ?? '',
                  },
                };
              })} />
                {modalDestinationPreview && (
                  <p className={`mt-1 text-xs ${modalDestinationPreview.needsFolderCreation ? 'text-amber-700' : 'text-slate-500'}`}>
                    {modalDestinationPreview.needsFolderCreation
                      ? `Folder "${modalDestinationPreview.missingFolderName}" not found. A new folder will be created on note creation.`
                      : `Ticker folder preview: ${modalDestinationPreview.fallbackPath}`}
                  </p>
                )}
              </label>
              <label className="text-sm">Assignee<select className="input mt-1" value={modalState.task.assignee} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, assignee: e.target.value } } : prev)}><option value="">—</option>{assignees.map((assignee) => <option key={assignee} value={assignee}>{assignee}</option>)}</select></label>
              <label className="text-sm">Note type<select className="input mt-1" value={modalState.task.note_type} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, note_type: e.target.value } } : prev)}>{noteTypes.length === 0 ? <option value="Research">Research</option> : noteTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select>
                {matchingTemplateForType(modalState.task.note_type)
                  ? <p className="mt-1 text-xs text-emerald-700">Template found and will be used.</p>
                  : null}
              </label>
              <label className="text-sm">Research location<select className="input mt-1" value={modalState.task.research_location_folder_id || ''} onChange={(e) => setModalState((prev) => {
                if (!prev) return prev;
                const selectedFolder = folders.find((folder) => folder.id === e.target.value) ?? null;
                return {
                  ...prev,
                  task: {
                    ...prev.task,
                    research_location_folder_id: selectedFolder?.id ?? '',
                    research_location_path: selectedFolder?.path ?? '',
                  },
                };
              })}><option value="">Auto (ticker/default)</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}</select>
                {modalDestinationPreview && (
                  <p className={`mt-1 text-xs ${modalDestinationPreview.needsFolderCreation ? 'text-amber-700' : 'text-slate-500'}`}>
                    {modalDestinationPreview.needsFolderCreation
                      ? `Destination preview: ${modalDestinationPreview.destinationPath} (will be created).`
                      : `Destination preview: ${modalDestinationPreview.destinationPath}`}
                  </p>
                )}
              </label>
              <label className="text-sm">Status<select className="input mt-1" value={modalState.task.status} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, status: e.target.value as TaskStatus } } : prev)}>{COLUMNS.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}</select></label>
              <label className="text-sm">Priority<select className="input mt-1" value={modalState.task.priority} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, priority: e.target.value as Priority | '' } } : prev)}><option value="">—</option>{Object.values(Priority).map((value) => <option key={value} value={value}>{PRIORITY_LABEL[value]}</option>)}</select></label>
              <label className="text-sm">Deadline<input className="input mt-1" type="date" value={modalState.task.deadline} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, deadline: e.target.value } } : prev)} /></label>
              <label className="text-sm">Date completed<input className="input mt-1" type="date" value={modalState.task.date_completed} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, date_completed: e.target.value } } : prev)} />
                {modalState.mode === 'edit' && modalState.task.date_completed.trim() && modalState.task.status !== TaskStatus.Completed
                  ? <p className="mt-1 text-xs text-amber-700">Saving with a completion date will automatically move this task to Completed.</p>
                  : null}
              </label>
              <label className="text-sm md:col-span-2">Details<textarea className="input mt-1 min-h-32" value={modalState.task.details} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, details: e.target.value } } : prev)} /></label>
            </div>
            {modalState.id && (
              <div className="mt-4 rounded-lg border border-slate-200">
                <button className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-slate-700" onClick={() => setActivityExpanded((prev) => !prev)}>
                  <span>Activity</span>
                  <span>{activityExpanded ? '▾' : '▸'}</span>
                </button>
                {activityExpanded && (
                  <div className="border-t border-slate-200 px-3 py-2 text-xs text-slate-600">
                    {activityLoading && <p>Loading activity…</p>}
                    {activityError && <p className="text-rose-600">{activityError}</p>}
                    {!activityLoading && !activityError && activityItems.length === 0 && <p>No activity yet.</p>}
                    <ul className="space-y-2">
                      {activityItems.map((item) => (
                        <li key={item.id} className="rounded bg-slate-50 px-2 py-1">
                          <p>{item.description.endsWith('.') ? item.description.slice(0, -1) : item.description}</p>
                          <p className="text-[11px] text-slate-500">{new Date(item.created_at).toLocaleString()}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              {modalState.mode === 'edit' && modalState.id && <button className="mr-auto rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => { const task = tasks.find((item) => item.id === modalState.id); if (task) void createNoteFromTask(task); }}>{modalState.task.linked_note_file_id ? 'Open linked note' : 'Create note from task'}</button>}
              <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm" onClick={closeModal}>Cancel</button>
              <button className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={saving} onClick={() => void saveTask()}>{saving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
