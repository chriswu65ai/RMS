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

  const canSubmitConfig = useMemo(() => url.trim().length > 0 && anonKey.trim().length > 0, [url, anonKey]);

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
            <p>Run workspace initialization now (recommended). This creates an empty workspace. If schema is missing in a brand-new project, run migrations once with Supabase CLI (<code>supabase db push --include-all</code>), then retry here.</p>
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
