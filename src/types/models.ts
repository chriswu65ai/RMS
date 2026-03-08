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
  tags?: string[];
  template?: boolean;
  starred?: boolean;
};
