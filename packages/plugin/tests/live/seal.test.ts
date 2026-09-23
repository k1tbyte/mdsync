import { describe, expect, it } from "vitest";

import { deriveLiveKeys } from "@/crypto/live-keys";
import { docIdFor, seal, unseal } from "@/live/seal";

function dataKey(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

describe("live sealing", () => {
	it("opens what it sealed and nothing sealed under another key", async () => {
		const raw = dataKey();
		const keys = await deriveLiveKeys(raw);
		const sealed = await seal(keys, Uint8Array.of(1, 2, 3));

		expect(await unseal(await deriveLiveKeys(raw), sealed)).toEqual(
			Uint8Array.of(1, 2, 3),
		);
		expect(await unseal(await deriveLiveKeys(dataKey()), sealed)).toBeNull();
		expect(await unseal(keys, sealed.subarray(0, 12))).toBeNull();
	});

	it("names a document the same on every device holding the data key", async () => {
		const raw = dataKey();
		const [here, there] = await Promise.all([
			deriveLiveKeys(raw),
			deriveLiveKeys(raw),
		]);

		const id = await docIdFor(here, "notes/a.md", 0);
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect(await docIdFor(there, "notes/a.md", 0)).toBe(id);
		expect(await docIdFor(here, "notes/a.md", 1)).not.toBe(id);
		expect(await docIdFor(here, "notes/b.md", 0)).not.toBe(id);
		expect(
			await docIdFor(await deriveLiveKeys(dataKey()), "notes/a.md", 0),
		).not.toBe(id);
	});
});
