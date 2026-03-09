import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type SetupState = {
  status: 'ready' | 'needs_setup';
  message: string;
  source: 'env' | 'runtime' | 'missing';
};

type RuntimeConfig = {
  url: string;
  anonKey: string;
};

const STORAGE_KEY = 'promptmanager.supabase.runtimeConfig';
const FALLBACK_URL = 'http://127.0.0.1:54321';
const FALLBACK_KEY = 'missing-anon-key';

function readRuntimeConfig(): RuntimeConfig | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeConfig>;
    if (!parsed.url || !parsed.anonKey) return null;
    return { url: parsed.url, anonKey: parsed.anonKey };
  } catch {
    return null;
  }
}

export function getRuntimeSupabaseConfig(): RuntimeConfig | null {
  return readRuntimeConfig();
}

function isLikelyValidUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isLikelyAnonKey(value: string) {
  return value.trim().length > 20;
}

function validateConfig(config: RuntimeConfig | null): SetupState {
  if (!config) {
    return {
      status: 'needs_setup',
      message: 'Supabase project URL and anon key are required before you can sign in.',
      source: 'missing',
    };
  }

  if (!isLikelyValidUrl(config.url)) {
    return {
      status: 'needs_setup',
      message: 'Supabase URL is invalid. Use your project URL from Project Settings → API.',
      source: 'runtime',
    };
  }

  if (!isLikelyAnonKey(config.anonKey)) {
    return {
      status: 'needs_setup',
      message: 'Supabase anon key looks invalid. Paste the full anon/public API key.',
      source: 'runtime',
    };
  }

  return { status: 'ready', message: '', source: 'runtime' };
}

function resolveConfig(): { config: RuntimeConfig | null; source: SetupState['source'] } {
  const envConfig = {
    url: import.meta.env.VITE_SUPABASE_URL as string | undefined,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  };

  if (envConfig.url && envConfig.anonKey) {
    return { config: { url: envConfig.url, anonKey: envConfig.anonKey }, source: 'env' };
  }

  const runtimeConfig = readRuntimeConfig();
  if (runtimeConfig) {
    return { config: runtimeConfig, source: 'runtime' };
  }

  return { config: null, source: 'missing' };
}

function createSupabaseClient(config: RuntimeConfig | null): SupabaseClient {
  if (!config) {
    return createClient(FALLBACK_URL, FALLBACK_KEY, { auth: { persistSession: false } });
  }
  return createClient(config.url, config.anonKey);
}

const resolved = resolveConfig();

export let setupState: SetupState = {
  ...validateConfig(resolved.config),
  source: resolved.config ? resolved.source : 'missing',
};

export let supabase = createSupabaseClient(setupState.status === 'ready' ? resolved.config : null);

export function saveRuntimeSupabaseConfig(config: RuntimeConfig) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  const nextState = validateConfig(config);
  setupState = { ...nextState, source: 'runtime' };
  supabase = createSupabaseClient(nextState.status === 'ready' ? config : null);
}

export function clearRuntimeSupabaseConfig() {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY);
  }

  const next = resolveConfig();
  setupState = {
    ...validateConfig(next.config),
    source: next.config ? next.source : 'missing',
  };
  supabase = createSupabaseClient(setupState.status === 'ready' ? next.config : null);
}

export function getSupabaseSetupState() {
  return setupState;
}
