import { createTestControllerHost } from "@tests/helpers/controller";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { SyncController } from "@/sync/controller";

useEncryptionKey();

describe("pushing one segment of a hunk", () => {
	it("publishes that edit alone and keeps its neighbour local", async () => {
		const [a, b] = pairedSessions();
		const laptop = new SyncController(createTestControllerHost(a));
		const phone = new SyncController(createTestControllerHost(b));
		a.adapter.putText("n.md", "a\nb\nc\nd\n");
		await laptop.refreshAndAutoSync();
		a.adapter.putText("n.md", "A\nb\nc\nD\n");
		await laptop.refresh();

		const second = new Map([[0, new Set([1])]]);
		expect(await laptop.pushHunks("n.md", second)).toMatchObject({ ok: true });
		await phone.refreshAndAutoSync();
		expect(b.adapter.readText("n.md")).toBe("a\nb\nc\nD\n");
		expect(a.adapter.readText("n.md")).toBe("A\nb\nc\nD\n");
	});
});
