import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { decryptJson } from "@/crypto";
import { advanceSessionAfterPush } from "@/sync/baseline";
import { REMOTE_MANIFEST_KEY } from "@/sync/constants";
import { compare, pushPaths } from "@/sync/engine";
import { assertSpacePresent, SpaceGoneError, VAULT_SPACE } from "@/sync/space";
import type { Manifest } from "@/sync/types";

describe("space root translation at the codec boundary", () => {
	useEncryptionKey();

	it("publishes relative keys but compare() sees vault paths", async () => {
		const session = new TestSession();
		// Override space to a non-empty root.
		const deps = () => ({
			...session.deps(),
			space: { id: "shared", root: "Shared/p" },
		});

		session.adapter.putText("Shared/p/a.md", "hello");

		const cmp = await compare(deps());
		expect(cmp.diff.localChanges.map((c) => c.path)).toEqual(["Shared/p/a.md"]);

		const manifest = await pushPaths(deps(), cmp, ["Shared/p/a.md"]);
		// Engine returns vault paths.
		expect(manifest.files["Shared/p/a.md"]).toBeTruthy();

		// The encrypted blob on storage holds relative paths.
		const blob = await session.storage.get(REMOTE_MANIFEST_KEY);
		if (!blob) throw new Error("Expected blob");
		const raw = await decryptJson<Manifest>(deps().key, blob);
		expect(Object.keys(raw.files)).toEqual(["a.md"]);

		// After advancing, a clean compare sees vault paths.
		session.state = advanceSessionAfterPush(session.state, cmp, manifest);
		const cmp2 = await compare(deps());
		expect(cmp2.remote).not.toBeNull();
		expect(cmp2.remote?.files["Shared/p/a.md"]).toBeTruthy();
		expect(cmp2.diff.localChanges).toHaveLength(0);
		expect(cmp2.diff.remoteChanges).toHaveLength(0);
	});

	it("refuses a share whose folder vanished instead of deleting it for everyone", async () => {
		const session = new TestSession();
		const deps = () => ({
			...session.deps(),
			space: { id: "shared", root: "Shared/p" },
		});
		session.adapter.putText("Shared/p/a.md", "hello");
		const cmp = await compare(deps());
		session.state = advanceSessionAfterPush(
			session.state,
			cmp,
			await pushPaths(deps(), cmp, ["Shared/p/a.md"]),
		);

		await session.adapter.remove("Shared/p/a.md");

		await expect(compare(deps())).rejects.toBeInstanceOf(SpaceGoneError);
		// A new file in the returned folder does not lift it.
		session.adapter.putText("Shared/p/new.md", "fresh");
		await expect(compare(deps())).rejects.toBeInstanceOf(SpaceGoneError);
		// Unless the person chose to publish the loss.
		const accepted = await compare({
			...deps(),
			space: { id: "shared", root: "Shared/p", goneAccepted: true },
		});
		expect(accepted.diff.localChanges.map(({ path }) => path).sort()).toEqual([
			"Shared/p/a.md",
			"Shared/p/new.md",
		]);
		// A file left out of the sync is still there.
		const baseline = { files: { "Shared/p/a.md": 1 } };
		const space = { id: "shared", root: "Shared/p" };
		expect(() =>
			assertSpacePresent(
				space,
				{ files: {}, skipped: [{ path: "Shared/p/a.md" }] },
				baseline,
			),
		).not.toThrow();
		// The vault itself may still be emptied on purpose.
		expect(() =>
			assertSpacePresent(VAULT_SPACE, { files: {} }, { files: { a: 1 } }),
		).not.toThrow();
		// A baseline from another mount point says nothing about this folder.
		const moved = { id: "shared", root: "Elsewhere" };
		expect(() =>
			assertSpacePresent(
				moved,
				{ files: {} },
				{ files: { "Shared/p/a.md": 1 } },
			),
		).not.toThrow();
	});
});
