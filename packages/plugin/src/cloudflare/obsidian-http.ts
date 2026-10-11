import { requestUrl } from "obsidian";

import type { Http } from "./api";

/**
 * Kept out of index.ts so the module still loads in Node. `throw: false`: Cloudflare's error envelope
 * says more than requestUrl's exception.
 */
export const obsidianHttp: Http = async (request) => {
	const res = await requestUrl({ ...request, throw: false });
	return { status: res.status, text: res.text };
};
