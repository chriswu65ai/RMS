import { Link } from 'react-router-dom';

export function SettingsAIPage() {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">AI</h2>
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <p className="text-sm text-slate-600">
          Configure model providers, runtime controls, and agent tooling from the Agent workspace.
        </p>
        <Link className="mt-3 inline-flex rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50" to="/agent">
          Open Agent settings
        </Link>
      </div>
    </div>
  );
}
