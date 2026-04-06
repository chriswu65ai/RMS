export type CanonicalChatActionMode = 'assist' | 'confirm_required' | 'manual_only';
export type ChatCommandName = 'task' | 'note' | 'confirm' | 'cancel' | 'help';
export type ChatCommandPrefixMode = 'on' | 'off';
export type ChatCommandPrefixMap = Record<ChatCommandName, string>;
export type ChatToolTraceVisibility = 'detailed' | 'summary';

const DEFAULT_CHAT_ACTION_MODE: CanonicalChatActionMode = 'assist';
const DEFAULT_CHAT_COMMAND_PREFIX_MODE: ChatCommandPrefixMode = 'off';
const DEFAULT_CHAT_COMMAND_PREFIX_MAP: ChatCommandPrefixMap = {
  task: '/task',
  note: '/note',
  confirm: '/confirm',
  cancel: '/cancel',
  help: '/help',
};

const LEGACY_CHAT_ACTION_MODE_MAP: Record<string, CanonicalChatActionMode> = {
  assist: 'assist',
  act: 'confirm_required',
  confirm: 'confirm_required',
  require_confirm: 'confirm_required',
  requires_confirm: 'confirm_required',
  confirm_required: 'confirm_required',
  manual: 'manual_only',
  manual_only: 'manual_only',
};

const asObjectRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

export const resolveChatActionMode = (
  rawMode: unknown,
): { mode: CanonicalChatActionMode; normalizedFrom: string | null; warningCode?: 'unknown_chat_action_mode' } => {
  if (typeof rawMode !== 'string') return { mode: DEFAULT_CHAT_ACTION_MODE, normalizedFrom: null };
  const normalizedInput = rawMode.trim().toLowerCase();
  const mapped = LEGACY_CHAT_ACTION_MODE_MAP[normalizedInput];
  if (mapped) {
    return {
      mode: mapped,
      normalizedFrom: normalizedInput !== mapped ? normalizedInput : null,
    };
  }
  return {
    mode: DEFAULT_CHAT_ACTION_MODE,
    normalizedFrom: normalizedInput || null,
    warningCode: 'unknown_chat_action_mode',
  };
};

export const normalizeChatSettingsPolicy = (
  policy: Record<string, unknown> | null | undefined,
): {
  policy: Record<string, unknown>;
  actionMode: CanonicalChatActionMode;
  normalizedFrom: string | null;
  commandPrefixMode: ChatCommandPrefixMode;
  commandPrefixMap: ChatCommandPrefixMap;
  warningCode?: 'unknown_chat_action_mode';
} => {
  const nextPolicy = { ...(policy ?? {}) };
  const resolved = resolveChatActionMode(nextPolicy.action_mode);
  nextPolicy.action_mode = resolved.mode;
  const rawPrefixMode = nextPolicy.command_prefix_mode;
  const normalizedPrefixMode: ChatCommandPrefixMode = rawPrefixMode === true || rawPrefixMode === 'on' ? 'on' : 'off';
  const rawPrefixMap = asObjectRecord(nextPolicy.command_prefix_map) ?? {};
  const normalizedPrefixMap: ChatCommandPrefixMap = {
    task: typeof rawPrefixMap.task === 'string' && rawPrefixMap.task.trim() ? rawPrefixMap.task.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.task,
    note: typeof rawPrefixMap.note === 'string' && rawPrefixMap.note.trim() ? rawPrefixMap.note.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.note,
    confirm: typeof rawPrefixMap.confirm === 'string' && rawPrefixMap.confirm.trim() ? rawPrefixMap.confirm.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.confirm,
    cancel: typeof rawPrefixMap.cancel === 'string' && rawPrefixMap.cancel.trim() ? rawPrefixMap.cancel.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.cancel,
    help: typeof rawPrefixMap.help === 'string' && rawPrefixMap.help.trim() ? rawPrefixMap.help.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.help,
  };
  nextPolicy.command_prefix_mode = normalizedPrefixMode;
  nextPolicy.command_prefix_map = normalizedPrefixMap;
  return {
    policy: nextPolicy,
    actionMode: resolved.mode,
    normalizedFrom: resolved.normalizedFrom,
    commandPrefixMode: normalizedPrefixMode,
    commandPrefixMap: normalizedPrefixMap,
    warningCode: resolved.warningCode,
  };
};

export type ResolvedChatRuntimeSettings = {
  actionMode: CanonicalChatActionMode;
  askWhenInfoMissing: boolean;
  commandPrefixMode: ChatCommandPrefixMode;
  commandPrefixMap: ChatCommandPrefixMap;
  toolTraceVisibility: ChatToolTraceVisibility;
  webSearchEnabled: boolean;
};

export const resolveChatRuntimeSettings = (args: {
  normalizedPolicy: ReturnType<typeof normalizeChatSettingsPolicy>;
  requestBody?: Record<string, unknown>;
  agentGenerationParams?: Record<string, unknown> | null;
}): ResolvedChatRuntimeSettings => {
  const { normalizedPolicy, requestBody = {}, agentGenerationParams } = args;
  const policy = normalizedPolicy.policy;
  const requestActionMode = typeof requestBody.action_mode === 'string' ? resolveChatActionMode(requestBody.action_mode).mode : null;
  const requestPrefixMode = requestBody.command_prefix_mode === true || requestBody.command_prefix_mode === 'on'
    ? 'on'
    : (requestBody.command_prefix_mode === false || requestBody.command_prefix_mode === 'off' ? 'off' : null);
  const policyWebSearchEnabled = typeof policy.web_search_enabled === 'boolean' ? policy.web_search_enabled : null;
  const requestWebSearchEnabled = typeof requestBody.web_search_enabled === 'boolean' ? requestBody.web_search_enabled : null;
  const agentWebSearchEnabled = Boolean((asObjectRecord(agentGenerationParams)?.web_search as { enabled?: boolean } | undefined)?.enabled);

  // Precedence order (highest -> lowest): per-request override, normalized chat policy, global agent settings, defaults.
  const actionMode = requestActionMode ?? normalizedPolicy.actionMode;
  const commandPrefixMode = requestPrefixMode ?? normalizedPolicy.commandPrefixMode;
  const askWhenInfoMissing = requestBody.ask_when_missing === undefined
    ? (policy.ask_when_missing ?? true) !== false
    : Boolean(requestBody.ask_when_missing);
  const detailedToolSteps = requestBody.detailed_tool_steps === undefined
    ? policy.detailed_tool_steps !== false
    : Boolean(requestBody.detailed_tool_steps);
  const webSearchEnabled = requestWebSearchEnabled ?? policyWebSearchEnabled ?? agentWebSearchEnabled;

  return {
    actionMode,
    askWhenInfoMissing,
    commandPrefixMode,
    commandPrefixMap: normalizedPolicy.commandPrefixMap,
    toolTraceVisibility: detailedToolSteps ? 'detailed' : 'summary',
    webSearchEnabled,
  };
};
