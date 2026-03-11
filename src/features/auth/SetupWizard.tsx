import { useMemo, useState } from 'react';
import {
  clearRuntimeSupabaseConfig,
  getRuntimeSupabaseConfig,
  getSupabaseSetupState,
  saveRuntimeSupabaseConfig,
  supabase,
} from '../../lib/supabase';
import { initializeStarterWorkspace } from '../../lib/dataApi';
import { checkSchemaHealth, toUserFacingBootstrapError } from '../../lib/schemaHealth';
import {
  getSupabaseProvisioningStatus,
  listSupabaseManagementProjects,
  startSupabaseProvisioning,
  type SupabaseManagementProject,
} from '../../lib/setupApi';

type Props = {
  onReady: () => void;
};

function extractProjectRef(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname;
    if (!host.endsWith('.supabase.co')) return null;
    return host.split('.')[0] ?? null;
  } catch {
    return null;
  }
}

const allowDevPatMode = import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_PAT_SETUP === 'true';

export function SetupWizard({ onReady }: Props) {
  const initialState = getSupabaseSetupState();
  const existingRuntimeConfig = getRuntimeSupabaseConfig();
  const [step, setStep] = useState(1);
  const [setupMode, setSetupMode] = useState<'existing' | 'create'>('existing');
  const [createMode, setCreateMode] = useState<'new' | 'select'>('new');
  const [url, setUrl] = useState(existingRuntimeConfig?.url ?? '');
  const [anonKey, setAnonKey] = useState(existingRuntimeConfig?.anonKey ?? '');
  const [organizationId, setOrganizationId] = useState('');
  const [projectName, setProjectName] = useState('prompt-manager');
  const [region, setRegion] = useState('us-east-1');
  const [plan, setPlan] = useState('free');
  const [dbPass, setDbPass] = useState('');
  const [projects, setProjects] = useState<SupabaseManagementProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [selectedProjectRef, setSelectedProjectRef] = useState('');
  const [status, setStatus] = useState<string>(initialState.message);
  const [checking, setChecking] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [installingSchema, setInstallingSchema] = useState(false);
  const [accessToken, setAccessToken] = useState('');

  const canSubmitConfig = useMemo(() => {
    if (setupMode === 'create') {
      if (createMode === 'new') {
        return organizationId.trim().length > 0 && projectName.trim().length > 0;
      }
      return selectedProjectRef.trim().length > 0;
    }
    return url.trim().length > 0 && anonKey.trim().length > 0;
  }, [anonKey, createMode, organizationId, projectName, selectedProjectRef, setupMode, url]);

  const projectRef = useMemo(() => {
    if (setupMode === 'create' && createMode === 'select' && selectedProjectRef.trim()) {
      return selectedProjectRef.trim();
    }
    return extractProjectRef(url);
  }, [createMode, selectedProjectRef, setupMode, url]);

  const validateConnection = async () => {
    setChecking(true);
    setStatus('Validating Supabase connection...');
    saveRuntimeSupabaseConfig({ url: url.trim(), anonKey: anonKey.trim() });

    const state = getSupabaseSetupState();
    if (state.status !== 'ready') {
      setStatus(state.message);
      setChecking(false);
      return;
    }

    const { error } = await supabase.auth.getSession();
    if (error) {
      setStatus(`Connection failed: ${error.message}`);
      setChecking(false);
      return;
    }

    const schema = await checkSchemaHealth();
    if (!schema.ok) {
      setStatus(schema.message);
      setChecking(false);
      setStep(4);
      return;
    }

    setStatus('Connection and schema validation succeeded. Continue to initialize your workspace.');
    setChecking(false);
    setStep(4);
  };

  const loadProjects = async () => {
    if (allowDevPatMode && !accessToken.trim()) {
      setStatus('Dev mode requires a PAT for backend token exchange when no server PAT is configured.');
      return;
    }

    setProjectsLoading(true);
    setStatus('Loading Supabase projects from Management API...');

    try {
      const response = await listSupabaseManagementProjects({
        organizationId: organizationId.trim() || undefined,
        devAccessToken: allowDevPatMode ? accessToken.trim() : undefined,
      });
      setProjects(response.projects);
      if (response.projects.length > 0 && !selectedProjectRef) {
        setSelectedProjectRef(response.projects[0]?.id ?? '');
      }
      setStatus(response.projects.length ? 'Projects loaded. Select one and continue.' : 'No projects found for the provided criteria.');
    } catch (error) {
      setStatus(`Could not load projects: ${error instanceof Error ? error.message : 'Unknown error.'}`);
    } finally {
      setProjectsLoading(false);
    }
  };

  const runBootstrap = async () => {
    setBootstrapping(true);
    const { error } = await initializeStarterWorkspace();
    if (error) {
      setStatus(`Initialization check: ${toUserFacingBootstrapError(error.message)}. This can be run automatically after sign-in.`);
    } else {
      setStatus('Workspace initialization finished successfully.');
    }
    setBootstrapping(false);
  };

  const installSchema = async () => {
    if (allowDevPatMode && !accessToken.trim()) {
      setStatus('Dev mode requires a PAT for backend token exchange when no server PAT is configured.');
      return;
    }

    if (setupMode === 'existing' && !projectRef) {
      setStatus('Could not detect project ID from URL. Expected format: https://<project-ref>.supabase.co');
      return;
    }

    if (setupMode === 'create' && createMode === 'select' && !selectedProjectRef.trim()) {
      setStatus('Please select an existing Supabase project to continue.');
      return;
    }

    setInstallingSchema(true);
    setStatus(setupMode === 'create' ? 'Running backend provisioning...' : 'Starting secure backend provisioning...');

    try {
      const started = await startSupabaseProvisioning(
        setupMode === 'create'
          ? createMode === 'new'
            ? {
                createProject: {
                  organizationId: organizationId.trim(),
                  name: projectName.trim(),
                  region: region.trim() || undefined,
                  plan: plan.trim() || undefined,
                  dbPass: dbPass.trim() || undefined,
                },
                devAccessToken: allowDevPatMode ? accessToken.trim() : undefined,
              }
            : {
                projectRef: selectedProjectRef.trim(),
                devAccessToken: allowDevPatMode ? accessToken.trim() : undefined,
              }
          : {
              projectUrl: url.trim(),
              projectRef,
              devAccessToken: allowDevPatMode ? accessToken.trim() : undefined,
            },
      );

      let isComplete = false;
      while (!isComplete) {
        const current = await getSupabaseProvisioningStatus(started.operationId);
        setStatus(current.message);

        if (current.status === 'failed') {
          throw new Error(current.message);
        }

        if (current.status === 'succeeded') {
          if (current.result?.projectUrl && current.result.anonKey) {
            saveRuntimeSupabaseConfig({ url: current.result.projectUrl, anonKey: current.result.anonKey });
            setUrl(current.result.projectUrl);
            setAnonKey(current.result.anonKey);
          }
          isComplete = true;
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (error) {
      setStatus(`Schema install failed: ${error instanceof Error ? error.message : 'Unknown error.'}`);
      setInstallingSchema(false);
      return;
    }

    const schema = await checkSchemaHealth();
    if (!schema.ok) {
      setStatus(`Schema install finished, but validation still failed: ${schema.message}`);
      setInstallingSchema(false);
      return;
    }

    setStatus('Schema installed successfully. You can now initialize your workspace.');
    setInstallingSchema(false);
  };

  const finish = () => onReady();

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="card w-full max-w-2xl space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold">First-run setup</h1>
          <p className="text-sm text-slate-600">Configure Supabase before using Prompt Manager.</p>
        </div>

        <ol className="grid gap-2 text-sm md:grid-cols-4">
          {['Create project', 'Paste credentials', 'Validate', 'Initialize workspace'].map((label, index) => {
            const active = step === index + 1;
            return (
              <li key={label} className={`rounded border px-3 py-2 ${active ? 'border-slate-900 bg-slate-100' : 'border-slate-200'}`}>
                {index + 1}. {label}
              </li>
            );
          })}
        </ol>

        {step === 1 && (
          <div className="space-y-3 text-sm text-slate-700">
            <p>How do you want to set up Supabase?</p>
            <div className="grid gap-2 md:grid-cols-2">
              <button
                className={`rounded border px-3 py-2 text-left ${setupMode === 'existing' ? 'border-slate-900 bg-slate-100' : 'border-slate-200'}`}
                onClick={() => setSetupMode('existing')}
              >
                <strong>I already have project credentials</strong>
                <p className="text-xs text-slate-500">Paste project URL + anon key.</p>
              </button>
              <button
                className={`rounded border px-3 py-2 text-left ${setupMode === 'create' ? 'border-slate-900 bg-slate-100' : 'border-slate-200'}`}
                onClick={() => setSetupMode('create')}
              >
                <strong>I only have API access</strong>
                <p className="text-xs text-slate-500">Start new or select an existing project from your Supabase account.</p>
              </button>
            </div>
            <button className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white" onClick={() => setStep(2)}>Continue</button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            {setupMode === 'existing' ? (
              <>
                <p className="text-xs text-slate-500">
                  Current config source: <strong>{initialState.source}</strong>
                  {initialState.source === 'env'
                    ? ' (configured by host environment variables).'
                    : initialState.source === 'runtime'
                      ? ' (stored in this browser, can be switched here).'
                      : ' (not configured yet).'}
                </p>
                <label className="block text-sm">
                  Supabase URL
                  <input className="input mt-1" placeholder="https://xxxx.supabase.co" value={url} onChange={(e) => setUrl(e.target.value)} />
                </label>
                <label className="block text-sm">
                  Supabase anon key
                  <textarea className="input mt-1 min-h-28" value={anonKey} onChange={(e) => setAnonKey(e.target.value)} />
                </label>
              </>
            ) : (
              <>
                <p className="text-xs text-slate-500">Use backend provisioning: either create a new project or select one from your Supabase account, then apply migrations from <code>supabase/migrations</code>.</p>
                <div className="grid gap-2 md:grid-cols-2">
                  <button
                    className={`rounded border px-3 py-2 text-left ${createMode === 'new' ? 'border-slate-900 bg-slate-100' : 'border-slate-200'}`}
                    onClick={() => setCreateMode('new')}
                  >
                    <strong>Start new project</strong>
                  </button>
                  <button
                    className={`rounded border px-3 py-2 text-left ${createMode === 'select' ? 'border-slate-900 bg-slate-100' : 'border-slate-200'}`}
                    onClick={() => setCreateMode('select')}
                  >
                    <strong>Select existing project</strong>
                  </button>
                </div>

                <label className="block text-sm">
                  Organization ID {createMode === 'new' ? '' : '(optional filter)'}
                  <input className="input mt-1" placeholder="org_..." value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} />
                </label>

                {createMode === 'new' ? (
                  <>
                    <label className="block text-sm">
                      Project name
                      <input className="input mt-1" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
                    </label>
                    <label className="block text-sm">
                      Region
                      <input className="input mt-1" value={region} onChange={(e) => setRegion(e.target.value)} />
                    </label>
                    <label className="block text-sm">
                      Plan
                      <input className="input mt-1" value={plan} onChange={(e) => setPlan(e.target.value)} />
                    </label>
                    <label className="block text-sm">
                      Database password (optional)
                      <input type="password" className="input mt-1" value={dbPass} onChange={(e) => setDbPass(e.target.value)} />
                    </label>
                  </>
                ) : (
                  <>
                    <button
                      disabled={projectsLoading}
                      className="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
                      onClick={loadProjects}
                    >
                      {projectsLoading ? 'Loading projects...' : 'Load projects'}
                    </button>
                    <label className="block text-sm">
                      Existing Supabase project
                      <select className="input mt-1" value={selectedProjectRef} onChange={(e) => setSelectedProjectRef(e.target.value)}>
                        <option value="">Select project...</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name} ({project.id}){project.region ? ` • ${project.region}` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </>
            )}

            <div className="flex flex-wrap gap-2">
              <button className="rounded border border-slate-300 px-4 py-2 text-sm" onClick={() => setStep(1)}>Back</button>
              <button disabled={!canSubmitConfig} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60" onClick={() => setStep(3)}>Continue</button>
              <button
                className="rounded border border-rose-300 px-4 py-2 text-sm text-rose-700"
                onClick={() => {
                  clearRuntimeSupabaseConfig();
                  setUrl('');
                  setAnonKey('');
                  setStatus('Runtime credentials reset.');
                }}
              >
                Reset credentials
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3 text-sm text-slate-700">
            {setupMode === 'existing' ? <p>Validate connectivity using <code>auth.getSession()</code>.</p> : <p>Provision and apply schema, then save runtime config automatically.</p>}
            <div className="flex gap-2">
              <button className="rounded border border-slate-300 px-4 py-2 text-sm" onClick={() => setStep(2)}>Back</button>
              {setupMode === 'existing' ? (
                <button disabled={checking} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60" onClick={validateConnection}>Validate connection</button>
              ) : (
                <button disabled={installingSchema} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60" onClick={installSchema}>Run provisioning + install schema</button>
              )}
              <button className="rounded border border-slate-300 px-4 py-2 text-sm" onClick={() => setStep(4)}>Skip to initialize</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3 text-sm text-slate-700">
            <p>Run workspace initialization now (recommended). This creates an empty workspace.</p>
            <div className="rounded border border-slate-200 bg-slate-50 p-3">
              <p className="mb-2 text-xs text-slate-600">No-CLI option: this action calls a backend provisioning endpoint. The browser never receives the backend-managed PAT.</p>
              <p className="mb-2 text-xs text-slate-500">Detected project ref: <strong>{projectRef ?? 'not detected'}</strong></p>
              {allowDevPatMode ? (
                <label className="block text-xs">
                  <span className="font-semibold text-amber-700">Dev-only override:</span> Supabase PAT (never returned to client)
                  <input
                    type="password"
                    className="input mt-1"
                    placeholder="sbp_..."
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                  />
                </label>
              ) : (
                <p className="text-xs text-slate-500">Hosted/prod mode: PAT input is disabled. Configure <code>SUPABASE_MANAGEMENT_PAT</code> on the backend.</p>
              )}
              <button
                disabled={installingSchema || (setupMode === 'existing' && !projectRef) || (setupMode === 'create' && createMode === 'select' && !selectedProjectRef)}
                className="mt-2 rounded border border-slate-300 px-3 py-2 text-xs disabled:opacity-60"
                onClick={installSchema}
              >
                {installingSchema ? 'Installing schema...' : 'Install schema now (secure backend)'}
              </button>
            </div>
            <div className="flex gap-2">
              <button disabled={bootstrapping} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60" onClick={runBootstrap}>Initialize workspace</button>
              <button className="rounded border border-slate-300 px-4 py-2 text-sm" onClick={finish}>Continue to sign-in</button>
              <button className="rounded border border-rose-300 px-4 py-2 text-sm text-rose-700" onClick={clearRuntimeSupabaseConfig}>Reset config</button>
            </div>
          </div>
        )}

        {status && <p className="rounded bg-slate-100 px-3 py-2 text-xs text-slate-600">{status}</p>}
      </div>
    </div>
  );
}
