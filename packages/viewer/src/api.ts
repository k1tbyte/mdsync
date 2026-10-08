/** The relay's public link routes, as the viewer sees them. */

import { LINK_HEADERS, type LinkMeta } from "@mdsync/protocol";

export type OpenOutcome =
	| {
			kind: "opened";
			sealed: Uint8Array;
			viewsLeft: number | null;
			expires: number | null;
	  }
	| { kind: "gone" }
	| { kind: "gate"; retryAfter: number | null }
	| { kind: "cooldown"; retryAfter: number };

export interface LinkApi {
	/** Null when the link is gone. Counts no view. */
	meta(id: string): Promise<LinkMeta | null>;
	/** Counts a view when it opens. */
	open(id: string, gate: string): Promise<OpenOutcome>;
}

export function createApi(
	fetcher: typeof fetch = (input, init) => window.fetch(input, init),
): LinkApi {
	return {
		async meta(id) {
			const response = await fetcher(`/link/${id}/meta`);
			if (response.status === 404) return null;
			if (!response.ok) throw relayError(response);
			return (await response.json()) as LinkMeta;
		},
		async open(id, gate) {
			const response = await fetcher(`/link/${id}/open`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ gate }),
			});
			if (response.ok) {
				const left = response.headers.get(LINK_HEADERS.viewsLeft);
				const expires = Number(response.headers.get(LINK_HEADERS.expires));
				return {
					kind: "opened",
					sealed: new Uint8Array(await response.arrayBuffer()),
					viewsLeft: left === null ? null : Number(left),
					expires: Number.isInteger(expires) && expires > 0 ? expires : null,
				};
			}
			if (response.status === 404) return { kind: "gone" };
			const retry = Number(response.headers.get("Retry-After"));
			const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : null;
			if (response.status === 401) return { kind: "gate", retryAfter };
			if (response.status === 429) {
				return { kind: "cooldown", retryAfter: retryAfter ?? 60 };
			}
			throw relayError(response);
		},
	};
}

function relayError(response: Response): Error {
	return new Error(`The relay answered ${response.status}.`);
}
