import { describe, expect, it } from "vitest";
import { chunkId, deriveChunkIds } from "@/core/crypto";

describe("chunk ids", () => {
	const bytes = new TextEncoder().encode("a chunk");

	it("names equal bytes alike under one data key, on any device", async () => {
		const here = await deriveChunkIds(new Uint8Array(32).fill(1));
		const there = await deriveChunkIds(new Uint8Array(32).fill(1));
		const id = await chunkId(here, bytes);
		expect(id).toMatch(/^[0-9a-f]{64}$/);
		expect(await chunkId(there, bytes)).toBe(id);
	});

	it("names them apart under another data key, and never by their plain hash", async () => {
		const one = await chunkId(
			await deriveChunkIds(new Uint8Array(32).fill(1)),
			bytes,
		);
		const two = await chunkId(
			await deriveChunkIds(new Uint8Array(32).fill(2)),
			bytes,
		);
		const plain = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		expect(one).not.toBe(two);
		expect(one).not.toBe(Buffer.from(plain).toString("hex"));
	});
});
