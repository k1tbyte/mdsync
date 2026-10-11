import { vi } from "vitest";

import type { StoredLink } from "@/links/record";
import { SharedLinks } from "@/links/shared-links";

const PUBLISHED = 1_760_000_000_000;

/** A link id from one character: `a` gives 22 of them. */
export function linkId(seed: string): string {
	return seed.repeat(22).slice(0, 22);
}

export function link(
	seed: string,
	path = `${seed}.md`,
	extra: Partial<StoredLink> = {},
): StoredLink {
	const id = linkId(seed);
	return {
		id,
		url: `https://relay.example/s/${id}#key`,
		rev: 0,
		author: "laptop",
		path,
		showTitle: true,
		detached: false,
		createdAt: PUBLISHED,
		publishedAt: PUBLISHED,
		expires: null,
		maxViews: null,
		salt: null,
		images: true,
		...extra,
	};
}

/** One device's links, persisted into its own settings object. */
export function linkDevice(links: StoredLink[] = [], author = "laptop") {
	const settings = { links };
	const save = vi.fn(async () => {});
	const announce = vi.fn();
	const shared = new SharedLinks({
		settings: () => settings,
		save,
		author: () => author,
		announce,
	});
	return { settings, save, announce, shared };
}
