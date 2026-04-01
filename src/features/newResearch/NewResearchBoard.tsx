import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FrontmatterModel, NewResearchTask, NewResearchTaskInput } from '../../types/models';
import { Priority, TaskStatus } from '../../types/models';
import { createFile, createNewResearchTask, deleteNewResearchTask, listNewResearchTasks, listTaskActivity, updateNewResearchTask } from '../../lib/dataApi';
import { buildCanonicalStockFileName, toLocalDateInputValue, usePromptStore } from '../../hooks/usePromptStore';
import { composeMarkdown } from '../../lib/frontmatter';
import { PageState } from '../../components/shared/PageState';

const COLUMNS: Array<{ key: TaskStatus; label: string }> = [
  { key: TaskStatus.Ideas, label: 'Ideas' },
  { key: TaskStatus.Researching, label: 'Researching' },
  { key: TaskStatus.Completed, label: 'Completed' },
];

type ModalState = { mode: 'create' | 'edit'; task: NewResearchTaskInput; id?: string };

const blankTask = (): NewResearchTaskInput => ({
  topic: '', ticker: '', note_type: 'Research', assignee: '', priority: '', deadline: '', status: TaskStatus.Ideas,
  date_completed: '', archived: false, linked_note_file_id: '', linked_note_path: '',
});

const todayDate = () => new Date().toISOString().slice(0, 10);

export function NewResearchBoard({ assignees, noteTypes }: { assignees: string[]; noteTypes: string[] }) {
  const navigate = useNavigate();
  const { workspace, folders, files, refresh, transitionTaskModal, transitionTaskToNote } = usePromptStore();
  const [tasks, setTasks] = useState<NewResearchTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [modalState, setModalState] = useState<ModalState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(true);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityItems, setActivityItems] = useState<Array<{ id: string; description: string; created_at: string }>>([]);

  const visibleTasks = useMemo(() => tasks.filter((task) => showArchived || !task.archived), [showArchived, tasks]);

  const loadTasks = async () => {
    setLoading(true);
    setError(null);
    try { setTasks(await listNewResearchTasks()); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load new research tasks.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void loadTasks(); }, []);

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

    setSaving(true);
    setError(null);
    try {
      if (modalState.mode === 'create') {
        const created = await createNewResearchTask(modalState.task);
        setTasks((prev) => [created, ...prev]);
      } else if (modalState.id) {
        const updated = await updateNewResearchTask(modalState.id, modalState.task);
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
    if (!window.confirm('Delete this task permanently?')) return;
    try { await deleteNewResearchTask(taskId); setTasks((prev) => prev.filter((task) => task.id !== taskId)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to delete task.'); }
  };

  const openLinkedNote = (task: NewResearchTask) => {
    const transition = transitionTaskToNote(task);
    if (!transition.ok) return setError(transition.reason ?? 'Linked note is unavailable.');
    navigate('/stock-research');
  };

  const createNoteFromTask = async (task: NewResearchTask) => {
    if (!workspace) return setError('Workspace is not ready yet.');
    const ticker = task.ticker.trim().toUpperCase();
    if (!ticker) return setError('Ticker is required before creating a note.');

    const type = (task.note_type || noteTypes[0] || 'Research').trim();
    const date = toLocalDateInputValue();
    const name = buildCanonicalStockFileName(date, ticker, type);
    const defaultFolder = folders.find((folder) => folder.path === 'Research') ?? null;
    const existing = files.find((file) => !file.is_template && file.name === name && file.folder_id === (defaultFolder?.id ?? null));

    if (existing) {
      const updatedTask = await updateNewResearchTask(task.id, { ...task, linked_note_file_id: existing.id, linked_note_path: existing.path });
      setTasks((prev) => prev.map((item) => (item.id === task.id ? updatedTask : item)));
      openLinkedNote(updatedTask);
      return;
    }

    const frontmatter: FrontmatterModel = { title: `${ticker} ${type}`, ticker, type, date, recommendation: '', stock_recommendation: '' };
    const content = composeMarkdown(frontmatter, `# ${ticker} ${type}\n\n## Task context\n${task.topic || '-'}\n`);
    const result = await createFile({ workspaceId: workspace.id, folderId: defaultFolder?.id ?? null, folderPath: defaultFolder?.path ?? null, name, content, frontmatter });
    if (result.error) return setError(result.error.message);

    await refresh();
    const created = usePromptStore.getState().files.find((file) => !file.is_template && file.path === `${defaultFolder?.path ? `${defaultFolder.path}/` : ''}${name}`);
    if (!created) return setError('Note created, but it could not be selected automatically.');

    const updatedTask = await updateNewResearchTask(task.id, { ...task, linked_note_file_id: created.id, linked_note_path: created.path });
    setTasks((prev) => prev.map((item) => (item.id === task.id ? updatedTask : item)));
    const transition = transitionTaskToNote(updatedTask, created.id);
    if (!transition.ok) return setError(transition.reason ?? 'Linked note is unavailable.');
    navigate('/stock-research');
  };

  const onModalKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      setModalState(null);
      transitionTaskModal(null);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white" onClick={() => { setModalState({ mode: 'create', task: blankTask() }); transitionTaskModal('new'); }}>+ Add task</button>
        <label className="inline-flex items-center gap-2 text-sm text-slate-600"><input checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} type="checkbox" />Show archived</label>
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
              <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold text-slate-800">{column.label}</h3><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{visibleTasks.filter((task) => task.status === column.key).length}</span></div>
              <div className="space-y-2">
                {visibleTasks.filter((task) => task.status === column.key).map((task) => (
                  <article key={task.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3" draggable onDragStart={() => setDraggingId(task.id)} onDragEnd={() => setDraggingId(null)}>
                    <div className="flex items-start justify-between gap-3">
                      <button className="text-left" onClick={() => { setModalState({ mode: 'edit', id: task.id, task: { ...task } }); transitionTaskModal(task.id); }}><p className="font-medium text-slate-900">{task.topic || 'Untitled topic'}</p><p className="text-xs text-slate-600">{task.ticker}</p></button>
                      <button className="text-xs text-rose-600" onClick={() => void removeTask(task.id)}>Delete</button>
                    </div>
                    <div className="mt-2 space-y-1 text-xs text-slate-600"><p>Assignee: {task.assignee || '—'}</p><p>Type: {task.note_type || '—'}</p><p>Priority: {task.priority || '—'}</p><p>Deadline: {task.deadline || '—'}</p><p>Completed: {task.date_completed || '—'}</p><p>Linked note: {task.linked_note_path || '—'}</p></div>
                    <div className="mt-3 flex items-center justify-between gap-2"><button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100" onClick={() => void createNoteFromTask(task)}>{task.linked_note_file_id ? 'Reopen note' : 'Create note from task'}</button><button className="text-xs text-slate-600 hover:text-slate-900" onClick={() => void toggleArchive(task)}>{task.archived ? 'Unarchive' : 'Archive'}</button></div>
                  </article>
                ))}
                {visibleTasks.filter((task) => task.status === column.key).length === 0 && <PageState kind="empty" message={`No tasks in ${column.label.toLowerCase()}.`} />}
              </div>
            </div>
          ))}
        </div>
      )}

      {modalState && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" onKeyDown={onModalKeyDown}>
          <div className="w-full max-w-xl rounded-xl bg-white p-4 shadow-xl">
            <h3 className="text-lg font-semibold">{modalState.mode === 'create' ? 'Create task' : 'Edit task'}</h3>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="text-sm md:col-span-2">Topic / question<input className="input mt-1" value={modalState.task.topic} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, topic: e.target.value } } : prev)} /></label>
              <label className="text-sm">Ticker *<input className="input mt-1" required value={modalState.task.ticker} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, ticker: e.target.value.toUpperCase() } } : prev)} /></label>
              <label className="text-sm">Note type<input className="input mt-1" list="new-research-note-types" value={modalState.task.note_type} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, note_type: e.target.value } } : prev)} /></label>
              <label className="text-sm">Assignee<input className="input mt-1" list="new-research-assignees" value={modalState.task.assignee} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, assignee: e.target.value } } : prev)} /></label>
              <label className="text-sm">Priority<select className="input mt-1" value={modalState.task.priority} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, priority: e.target.value as Priority | '' } } : prev)}><option value="">—</option>{Object.values(Priority).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              <label className="text-sm">Deadline<input className="input mt-1" type="date" value={modalState.task.deadline} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, deadline: e.target.value } } : prev)} /></label>
              <label className="text-sm">Status<select className="input mt-1" value={modalState.task.status} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, status: e.target.value as TaskStatus } } : prev)}>{COLUMNS.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}</select></label>
              <label className="text-sm">Date completed<input className="input mt-1" type="date" value={modalState.task.date_completed} onChange={(e) => setModalState((prev) => prev ? { ...prev, task: { ...prev.task, date_completed: e.target.value } } : prev)} /></label>
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
                          <p>{item.description}</p>
                          <p className="text-[11px] text-slate-500">{new Date(item.created_at).toLocaleString()}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <datalist id="new-research-assignees">{assignees.map((assignee) => <option key={assignee} value={assignee} />)}</datalist>
            <datalist id="new-research-note-types">{noteTypes.map((type) => <option key={type} value={type} />)}</datalist>
            <div className="mt-4 flex justify-end gap-2">
              {modalState.mode === 'edit' && modalState.id && <button className="mr-auto rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => { const task = tasks.find((item) => item.id === modalState.id); if (task) void createNoteFromTask(task); }}>{modalState.task.linked_note_file_id ? 'Open linked note' : 'Create note from task'}</button>}
              <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm" onClick={() => { setModalState(null); transitionTaskModal(null); }}>Cancel</button>
              <button className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={saving} onClick={() => void saveTask()}>{saving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
