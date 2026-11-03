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
