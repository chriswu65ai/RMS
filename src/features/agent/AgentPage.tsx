import { Link } from 'react-router-dom';
import { AgentSettingsSurface, WebSearchControls } from './components/AgentSettingsSurface';

export { WebSearchControls };

type AgentPageProps = {
  showLegacyBanner?: boolean;
};

export function AgentPage({ showLegacyBanner = false }: AgentPageProps) {
  return (
    <div className="h-full overflow-y-auto p-6">
      {showLegacyBanner ? (
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <p>
              AI configuration now lives in <Link className="font-medium underline underline-offset-2" to="/settings/ai">Settings → AI</Link>.
              This route is kept for backward compatibility.
            </p>
          </div>
        </div>
      ) : null}
      <AgentSettingsSurface />
    </div>
  );
}
