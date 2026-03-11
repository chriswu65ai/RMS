import { useEffect, useRef, useState } from 'react';
import { initializeStarterWorkspace } from '../../lib/dataApi';
import { checkSchemaHealth } from '../../lib/schemaHealth';
import { supabase } from '../../lib/supabase';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [email, setEmail] = useState('');
  const [authed, setAuthed] = useState(false);
  const [message, setMessage] = useState('');
  const initializedForSession = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setAuthed(!!data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_, session) => {
      initializedForSession.current = false;
      setAuthed(!!session);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!authed || initializedForSession.current) return;

    initializedForSession.current = true;
    void (async () => {
      const schema = await checkSchemaHealth();
      if (!schema.ok) return;
      await initializeStarterWorkspace();
    })();
  }, [authed]);

  if (authed) return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="card w-full max-w-sm p-6">
        <h2 className="mb-2 text-xl font-semibold">Sign in</h2>
        <p className="mb-4 text-sm text-slate-600">Use a magic link to access your prompts.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const { error } = await supabase.auth.signInWithOtp({ email });
            setMessage(error ? error.message : 'Check your email for a magic link.');
          }}
          className="space-y-3"
        >
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <button className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">Send magic link</button>
        </form>
        {message && <p className="mt-3 text-xs text-slate-500">{message}</p>}
      </div>
    </div>
  );
}
