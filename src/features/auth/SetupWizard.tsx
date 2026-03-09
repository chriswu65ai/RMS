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
<<<<<<< codex/automate-initial-workspace-setup-in-supabase-leuf7v
import { extractProjectRef, installSchemaWithAccessToken } from '../../lib/schemaInstaller';
=======
>>>>>>> main

type Props = {
  onReady: () => void;
};

export function SetupWizard({ onReady }: Props) {
  const initialState = getSupabaseSetupState();
  const existingRuntimeConfig = getRuntimeSupabaseConfig();
  const [step, setStep] = useState(1);
  const [url, setUrl] = useState(existingRuntimeConfig?.url ?? '');
  const [anonKey, setAnonKey] = useState(existingRuntimeConfig?.anonKey ?? '');
  const [status, setStatus] = useState<string>(initialState.message);
  const [checking, setChecking] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [installingSchema, setInstallingSchema] = useState(false);
  const [accessToken, setAccessToken] = useState('');

  const canSubmitConfig = useMemo(() => url.trim().length > 0 && anonKey.trim().length > 0, [url, anonKey]);
  const projectRef = useMemo(() => extractProjectRef(url), [url]);

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
    if (!projectRef) {
      setStatus('Could not detect project ID from URL. Expected format: https://<project-ref>.supabase.co');
      return;
    }
    if (!accessToken.trim()) {
      setStatus('Enter a Supabase Personal Access Token to install schema without CLI.');
      return;
    }

    setInstallingSchema(true);
    setStatus('Installing database schema via Supabase Management API...');

    const { error } = await installSchemaWithAccessToken(projectRef, accessToken.trim());
    if (error) {
      setStatus(`Schema install failed: ${error}`);
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

  const finish = () => {
    onReady();
  };

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
            <p>Create a Supabase project, then open <strong>Project Settings → API</strong> and copy:</p>
            <ul className="list-inside list-disc space-y-1">
              <li>Project URL</li>
              <li>anon/public API key</li>
            </ul>
            <div className="flex flex-wrap gap-3">
              <a className="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" href="https://supabase.com/dashboard/new" target="_blank" rel="noreferrer">Create Supabase project</a>
              <a className="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" href="https://supabase.com/docs/guides/getting-started" target="_blank" rel="noreferrer">Supabase getting started docs</a>
            </div>
            <button className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white" onClick={() => setStep(2)}>Continue</button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
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
            <p>Validate connectivity using <code>auth.getSession()</code>.</p>
            <div className="flex gap-2">
              <button className="rounded border border-slate-300 px-4 py-2 text-sm" onClick={() => setStep(2)}>Back</button>
              <button disabled={checking} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60" onClick={validateConnection}>Validate connection</button>
              <button className="rounded border border-slate-300 px-4 py-2 text-sm" onClick={() => setStep(4)}>Skip to initialize</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3 text-sm text-slate-700">
<<<<<<< codex/automate-initial-workspace-setup-in-supabase-leuf7v
            <p>Run workspace initialization now (recommended). This creates an empty workspace.</p>
            <div className="rounded border border-slate-200 bg-slate-50 p-3">
              <p className="mb-2 text-xs text-slate-600">No-CLI option: install schema from this page using your Supabase Personal Access Token. Project ref is auto-detected from the URL you entered.</p>
              <p className="mb-2 text-xs text-slate-500">Detected project ref: <strong>{projectRef ?? 'not detected'}</strong></p>
              <label className="block text-xs">
                Supabase Personal Access Token
                <input
                  type="password"
                  className="input mt-1"
                  placeholder="sbp_..."
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                />
              </label>
              <button
                disabled={installingSchema || !projectRef}
                className="mt-2 rounded border border-slate-300 px-3 py-2 text-xs disabled:opacity-60"
                onClick={installSchema}
              >
                {installingSchema ? 'Installing schema...' : 'Install schema now (no CLI)'}
              </button>
            </div>
=======
            <p>Run workspace initialization now (recommended). This creates an empty workspace. If schema is missing in a brand-new project, run migrations once with Supabase CLI (<code>supabase db push --include-all</code>), then retry here.</p>
>>>>>>> main
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
