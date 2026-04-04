import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

type AgentProvider = 'minimax' | 'openai' | 'anthropic' | 'ollama';

const SERVICE_PREFIX = 'rms.agent';
const ACCOUNT = 'default';
const fallbackPath = process.env.SECURE_STORE_PATH ?? path.resolve(process.cwd(), 'data/secure-store.json');

const readFallbackStore = () => {
  if (!existsSync(fallbackPath)) return {} as Record<string, string>;
  try {
    return JSON.parse(readFileSync(fallbackPath, 'utf8')) as Record<string, string>;
  } catch {
    return {} as Record<string, string>;
  }
};

const writeFallbackStore = (values: Record<string, string>) => {
  mkdirSync(path.dirname(fallbackPath), { recursive: true });
  writeFileSync(fallbackPath, JSON.stringify(values), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(fallbackPath, 0o600);
  } catch {
    // best effort permissions on non-posix systems
  }
};

const keychainService = (provider: AgentProvider) => `${SERVICE_PREFIX}.${provider}`;

const useMacKeychain = process.platform === 'darwin';

const readFromMacKeychain = (provider: AgentProvider): string | null => {
  try {
    return execFileSync('security', ['find-generic-password', '-a', ACCOUNT, '-s', keychainService(provider), '-w'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

const writeToMacKeychain = (provider: AgentProvider, secret: string) => {
  execFileSync('security', ['add-generic-password', '-a', ACCOUNT, '-s', keychainService(provider), '-w', secret, '-U'], { stdio: 'pipe' });
};

const deleteFromMacKeychain = (provider: AgentProvider) => {
  try {
    execFileSync('security', ['delete-generic-password', '-a', ACCOUNT, '-s', keychainService(provider)], { stdio: 'pipe' });
  } catch {
    // deleting absent key is non-fatal
  }
};

export const secretStore = {
  get(provider: AgentProvider) {
    if (useMacKeychain) return readFromMacKeychain(provider);
    const store = readFallbackStore();
    return store[provider] ?? null;
  },
  set(provider: AgentProvider, secret: string) {
    if (useMacKeychain) {
      writeToMacKeychain(provider, secret);
      return;
    }
    const store = readFallbackStore();
    store[provider] = secret;
    writeFallbackStore(store);
  },
  delete(provider: AgentProvider) {
    if (useMacKeychain) {
      deleteFromMacKeychain(provider);
      return;
    }
    const store = readFallbackStore();
    delete store[provider];
    writeFallbackStore(store);
  },
};
