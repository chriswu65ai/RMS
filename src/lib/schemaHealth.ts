import { supabase } from './supabase';

type SchemaStatus =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing_schema' | 'permission' | 'unknown';
      message: string;
    };

function isMissingSchemaMessage(message: string) {
  return message.includes("Could not find the table 'public.workspaces' in the schema cache");
}

export async function checkSchemaHealth(): Promise<SchemaStatus> {
  const { error } = await supabase.from('workspaces').select('id').limit(1);
  if (!error) return { ok: true };

  if (isMissingSchemaMessage(error.message)) {
    return {
      ok: false,
      reason: 'missing_schema',
      message:
        "Your Supabase project is connected, but database tables are not installed yet. Run project migrations once (for example: `supabase db push --include-all`) and return to continue.",
    };
  }

  if (error.code === '42501') {
    return {
      ok: false,
      reason: 'permission',
      message: 'Connected, but this account does not yet have permission to read Prompt Manager tables.',
    };
  }

  return {
    ok: false,
    reason: 'unknown',
    message: `Connection succeeded, but schema check failed: ${error.message}`,
  };
}

export function toUserFacingBootstrapError(message: string) {
  if (isMissingSchemaMessage(message)) {
    return "Supabase is connected, but Prompt Manager tables are missing in this project. Run database migrations once (e.g. `supabase db push --include-all`) and try again.";
  }
  return message;
}
