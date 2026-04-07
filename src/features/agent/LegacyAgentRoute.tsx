import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export function LegacyAgentRoute() {
  const navigate = useNavigate();

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      navigate('/settings/ai', { replace: true });
    }, 1200);
    return () => window.clearTimeout(timeoutId);
  }, [navigate]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700" role="status" aria-live="polite">
        <p>
          AI configuration has moved to <strong>Settings → AI</strong>. Redirecting now…
        </p>
      </div>
    </div>
  );
}
