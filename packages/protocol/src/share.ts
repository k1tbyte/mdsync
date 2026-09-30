/** The hub channel of a share: owner's devices and participants meet in it. */
export function shareChannel(shareId: string): string {
	return `obsync-share-${shareId}`;
}

/** Where a share's objects live under its owner's storage prefix; the broker confines participants to it. */
export function sharePrefix(prefix: string, shareId: string): string {
	const base = prefix.replace(/^\/+|\/+$/g, "");
	return `${base ? `${base}/` : ""}shares/${shareId}/`;
}

/** Object keys one `/share/sign` batch may name: a Worker on the free plan has 10 ms of CPU per request. */
export const SIGN_BATCH_MAX = 32;
