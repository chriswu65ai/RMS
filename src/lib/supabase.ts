export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'local-user' } } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    signInWithOtp: async () => ({ error: null }),
    signOut: async () => ({ error: null }),
  },
};

export function getSupabaseSetupState() {
  return { status: 'ready', message: '', source: 'local' as const };
}

export function getRuntimeSupabaseConfig() {
  return null;
}

export function saveRuntimeSupabaseConfig() {
  return;
}

export function clearRuntimeSupabaseConfig() {
  return;
}
