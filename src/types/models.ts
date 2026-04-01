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

export type FrontmatterModel = {
  title?: string;
  ticker?: string;
  type?: string;
  date?: string;
  sectors?: string[];
  recommendation?: '' | 'buy' | 'hold' | 'sell' | 'avoid';
  stock_recommendation?: '' | 'buy' | 'hold' | 'sell' | 'avoid';
  template?: boolean;
  starred?: boolean;
};

export type NewResearchTaskStatus = 'ideas' | 'researching' | 'completed';

export type NewResearchTask = {
  id: string;
  topic: string;
  ticker: string;
  note_type: string;
  assignee: string;
  priority: string;
  deadline: string;
  status: NewResearchTaskStatus;
  date_completed: string;
  archived: boolean;
  linked_note_file_id: string;
  linked_note_path: string;
  created_at: string;
  updated_at: string;
};

export type NewResearchTaskInput = {
  topic: string;
  ticker: string;
  note_type: string;
  assignee: string;
  priority: string;
  deadline: string;
  status: NewResearchTaskStatus;
  date_completed: string;
  archived: boolean;
  linked_note_file_id?: string;
  linked_note_path?: string;
};
