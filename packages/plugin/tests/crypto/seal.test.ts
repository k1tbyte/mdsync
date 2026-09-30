import { describe, expect, it } from "vitest";

import { deriveLiveKeys } from "@/crypto/live-keys";
import { seal, unseal } from "@/crypto/seal";

function dataKey(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

describe("sealing", () => {
	it("opens what it sealed and nothing sealed under another key", async () => {
		const raw = dataKey();
		const keys = await deriveLiveKeys(raw);
		const sealed = await seal(keys, Uint8Array.of(1, 2, 3), "doc:a");

		expect(await unseal(await deriveLiveKeys(raw), sealed, "doc:a")).toEqual(
			Uint8Array.of(1, 2, 3),
		);
		expect(
			await unseal(await deriveLiveKeys(dataKey()), sealed, "doc:a"),
		).toBeNull();
		expect(await unseal(keys, sealed.subarray(0, 12), "doc:a")).toBeNull();
	});

	it("opens nothing the relay moved to another document or kind", async () => {
		const keys = await deriveLiveKeys(dataKey());
		const sealed = await seal(keys, Uint8Array.of(1, 2, 3), "doc:a");

		expect(await unseal(keys, sealed, "doc:b")).toBeNull();
		expect(await unseal(keys, sealed, "awareness:a")).toBeNull();
		expect(await unseal(keys, sealed, "presence")).toBeNull();
	});
});
