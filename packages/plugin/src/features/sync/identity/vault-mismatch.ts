const MISMATCH = "Remote vault id does not match local";

export const VAULT_MISMATCH_MESSAGE = `${MISMATCH}. Refusing to sync to a different vault.`;

/** The refusal reaches consumers as snapshot text, so this is the only place that reads it. */
export function isVaultMismatch(error: string | null | undefined): boolean {
	return error?.includes(MISMATCH) ?? false;
}
