/**
 * Vault-relative form: forward slashes, no leading slash, NFC.
 *
 * Separators are normalised first, or a Windows-style leading `\` survives as
 * a leading `/`. macOS hands out decomposed filenames while every other
 * platform composes them, and the two spellings must not look like two files.
 */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC");
}

/**
 * True when any segment starts with a dot. Dot-directories (`.obsidian`,
 * `.trash`, `.git`) are outside every sync scope.
 */
export function hasDotSegment(path: string): boolean {
	return path.startsWith(".") || path.includes("/.");
}

/** A name as one folder on every platform: separators and reserved characters become "-", no leading or trailing dots. */
export function folderName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "-").replace(/^[.\s]+|[.\s]+$/g, "");
}

/** Drops one trailing slash, after normalising separators: `"a/b/" -> "a/b"`. */
export function stripTrailingSlash(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** Trims surrounding slashes and re-adds a single trailing one: `"/a/b/" → "a/b/"`. */
export function normalizeKeyPrefix(prefix: string): string {
	const trimmed = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return trimmed ? `${trimmed}/` : "";
}
