export type SupabaseProvisioningResult = {
  projectRef: string;
  projectUrl?: string;
  anonKey?: string;
};

export type SupabaseManagementProject = {
  id: string;
  organizationId: string;
  name: string;
  region?: string;
  status?: string;
};

type StartResponse = { operationId: string };

type StatusResponse = {
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  message: string;
  result?: SupabaseProvisioningResult;
};

type ProvisionNewProjectPayload = {
  createProject: {
    organizationId: string;
    name: string;
    region?: string;
    plan?: string;
    dbPass?: string;
  };
  devAccessToken?: string;
};

type ProvisionExistingProjectPayload = {
  projectUrl?: string;
  projectRef?: string | null;
  devAccessToken?: string;
};

export async function listSupabaseManagementProjects(payload: { organizationId?: string; devAccessToken?: string }) {
  const response = await fetch('/api/setup/supabase/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as { projects: SupabaseManagementProject[] };
}

export async function startSupabaseProvisioning(payload: ProvisionNewProjectPayload | ProvisionExistingProjectPayload) {
  const response = await fetch('/api/setup/supabase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as StartResponse;
}

export async function getSupabaseProvisioningStatus(operationId: string) {
  const response = await fetch(`/api/setup/supabase/${operationId}`);
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as StatusResponse;
}
