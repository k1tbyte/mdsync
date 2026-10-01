import type { DataAdapter } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "@/crypto";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { scanVault } from "@/vault/scanner";
import { createScopePolicy } from "@/vault/scope";

vi.mock("@/crypto", () => ({ sha256Hex: vi.fn() }));

const LARGE_BYTES = 8 * 1024 * 1024;
const paths = ["a.bin", "b.bin", "c.bin", "d.bin"];
const scope = createScopePolicy({
	configDir: ".obsidian",
	settingsSync: DEFAULT_SETTINGS_SYNC,
});

beforeEach(() => vi.mocked(sha256Hex).mockReset());

function scanning(size = LARGE_BYTES) {
	const readBinary = vi.fn(async () => new ArrayBuffer(size));
	const adapter = {
		stat: async () => ({ type: "file", size, mtime: 1 }),
		readBinary,
	} as unknown as DataAdapter;
	return {
		readBinary,
		run: () =>
			scanVault(
				adapter,
				scope,
				{
					maxFileBytes: LARGE_BYTES,
					concurrency: 4,
					index: {
						configDir: ".obsidian",
						files: () => paths.map((path) => ({ path, size, mtime: 1 })),
						folders: () => [],
						rename: async () => false,
					},
				},
				{},
			),
	};
}

describe("scanner memory admission", () => {
	it("holds one large buffer until hashing finishes", async () => {
		let active = 0;
		let peak = 0;
		vi.mocked(sha256Hex).mockImplementation(async () => {
			peak = Math.max(peak, ++active);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			active--;
			return "hash";
		});
		const scan = scanning();
		const { snapshot } = await scan.run();
		expect(Object.keys(snapshot.files)).toEqual(paths);
		expect(peak).toBe(1);
		expect(scan.readBinary).toHaveBeenCalledTimes(4);
	});

	it("releases admission after a failed hash", async () => {
		vi.mocked(sha256Hex)
			.mockRejectedValueOnce(new Error("hash failed"))
			.mockResolvedValue("hash");
		const { snapshot } = await scanning().run();
		expect(Object.keys(snapshot.files)).toEqual(paths.slice(1));
		expect(snapshot.skipped).toEqual([
			{ path: "a.bin", reason: "unreadable", detail: "Error: hash failed" },
		]);
	});
});
