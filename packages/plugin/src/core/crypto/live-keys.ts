import { deriveFromDataKey } from "./hkdf";

/** One key per live-layer purpose. */
export interface LiveKeys {
	/** AES-GCM-256 over every live frame the hub stores or forwards. */
	frames: CryptoKey;
	/** HMAC-SHA-256 naming documents, so the hub never learns a path. */
	docIds: CryptoKey;
}

const FRAMES_INFO = "mdsync/live/frames/v1";
const DOC_IDS_INFO = "mdsync/live/doc-ids/v1";

export async function deriveLiveKeys(dataKey: Uint8Array): Promise<LiveKeys> {
	const [frames, docIds] = await Promise.all([
		deriveFromDataKey(dataKey, FRAMES_INFO, { name: "AES-GCM", length: 256 }, [
			"encrypt",
			"decrypt",
		]),
		deriveFromDataKey(
			dataKey,
			DOC_IDS_INFO,
			{ name: "HMAC", hash: "SHA-256", length: 256 },
			["sign"],
		),
	]);
	return { frames, docIds };
}
