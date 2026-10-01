/**
 * Vault-relative form: forward slashes, no leading slash, NFC. Separators go first so a leading `\` cannot
 * become `/`; NFC because macOS hands out decomposed names.
 */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC");
}

/** Dot-directories (`.obsidian`, `.trash`, `.git`) are outside every sync scope. */
export function hasDotSegment(path: string): boolean {
	return path.startsWith(".") || path.includes("/.");
}

/**
 * A name as one folder on every platform: separators and reserved characters become "-", no leading or
 * trailing dots.
 */
export function folderName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "-").replace(/^[.\s]+|[.\s]+$/g, "");
}

/** Drops one trailing slash, after normalising separators: `"a/b/" -> "a/b"`. */
export function stripTrailingSlash(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** A relay URL that paths are appended to: trimmed, no trailing slash. */
export function relayBase(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

/** Trims surrounding slashes and re-adds a single trailing one: `"/a/b/" → "a/b/"`. */
export function normalizeKeyPrefix(prefix: string): string {
	const trimmed = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return trimmed ? `${trimmed}/` : "";
}
