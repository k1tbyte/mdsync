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

/** Refused in a name by Windows or Android's shared storage; the second class is U+0000-U+001F and DEL. */
const RESERVED_CHAR = /[\\/:*?"<>|]|[^ -~\u{80}-\u{10FFFF}]/u;

/**
 * A name as one folder on every platform: separators and reserved characters become "-", no leading or
 * trailing dots.
 */
export function folderName(name: string): string {
	return name
		.replace(new RegExp(RESERVED_CHAR, "gu"), "-")
		.replace(/^[.\s]+|[.\s]+$/g, "");
}

/** Some name in the path holds a character Windows and Android refuse. */
export function hasReservedChar(path: string): boolean {
	return path.split("/").some((name) => RESERVED_CHAR.test(name));
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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The secret rides every request: only a local relay may be reached without TLS. */
export function isCleartextRemote(url: string): boolean {
	try {
		const { protocol, hostname } = new URL(url.trim());
		return protocol === "http:" && !LOCAL_HOSTS.has(hostname);
	} catch {
		return false;
	}
}

/** Trims surrounding slashes and re-adds a single trailing one: `"/a/b/" → "a/b/"`. */
export function normalizeKeyPrefix(prefix: string): string {
	const trimmed = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return trimmed ? `${trimmed}/` : "";
}
