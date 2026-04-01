export async function checkSchemaHealth() {
  return { ok: true } as const;
}

export function toUserFacingBootstrapError(message: string) {
  return message;
}
