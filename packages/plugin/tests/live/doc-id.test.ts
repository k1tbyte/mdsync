import { describe, expect, it, vi } from "vitest";

import { deriveLiveKeys } from "@/crypto/live-keys";
import { docIdFor } from "@/live/doc-id";

function dataKey(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

describe("document ids", () => {
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

	it("derives each id once per key", async () => {
		const keys = await deriveLiveKeys(dataKey());
		const sign = vi.spyOn(crypto.subtle, "sign");

		const first = await docIdFor(keys, "notes/a.md", 0);
		expect(await docIdFor(keys, "notes/a.md", 0)).toBe(first);
		await docIdFor(keys, "notes/a.md", 1);

		expect(sign).toHaveBeenCalledTimes(2);
		sign.mockRestore();
	});
});
