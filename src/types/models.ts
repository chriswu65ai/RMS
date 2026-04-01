export type Workspace = {
  id: string;
  name: string;
};

export type Folder = {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
};

export enum Recommendation {
  Buy = 'buy',
  Hold = 'hold',
  Sell = 'sell',
  Avoid = 'avoid',
}

export enum TaskStatus {
  Ideas = 'ideas',
  Researching = 'researching',
  Completed = 'completed',
}

export enum Priority {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

export type SettingsList = {
  noteTypes: string[];
  assignees: string[];
};

export type Stock = {
  ticker: string;
  sectors: string[];
  recommendation: Recommendation | '';
};

export type Note = {
  id: string;
  title: string;
  type: string;
  date: string;
  assignee: string;
  stock: Stock;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type FrontmatterModel = {
  title?: string;
  ticker?: string;
  type?: string;
  date?: string;
  sectors?: string[];
  recommendation?: Recommendation | '';
  stock_recommendation?: Recommendation | '';
  assignee?: string;
  template?: boolean;
  starred?: boolean;
};

export type PromptFile = {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  name: string;
  path: string;
  content: string;
  frontmatter_json: Record<string, unknown> | null;
  is_template: boolean;
  created_at: string;
  updated_at: string;
};

export type Task = {
  id: string;
  topic: string;
  ticker: string;
  note_type: string;
  assignee: string;
  priority: Priority | '';
  deadline: string;
  status: TaskStatus;
  date_completed: string;
  archived: boolean;
  linked_note_file_id: string;
  linked_note_path: string;
  created_at: string;
  updated_at: string;
};

export type TaskInput = {
  topic: string;
  ticker: string;
  note_type: string;
  assignee: string;
  priority: Priority | '';
  deadline: string;
  status: TaskStatus;
  date_completed: string;
  archived: boolean;
  linked_note_file_id?: string;
  linked_note_path?: string;
};

// Backwards-compatible aliases for existing feature modules.
export type NewResearchTaskStatus = TaskStatus;
export type NewResearchTask = Task;
export type NewResearchTaskInput = TaskInput;

export type TaskActivityEvent = {
  id: string;
  task_id: string;
  event_type: string;
  description: string;
  created_at: string;
};
