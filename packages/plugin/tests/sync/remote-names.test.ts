import type { TestSession } from "@tests/helpers/session";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { Platform } from "obsidian";
import { describe, expect, it } from "vitest";
import { compare } from "@/sync/engine";
import { pullPathsOp } from "@/sync/operations/pull";
import { pushPathsOp } from "@/sync/operations/push";

useEncryptionKey();

/** Pushed from a case-sensitive disk, where both spellings are two files. */
async function pushFromLinux(
	session: TestSession,
	files: Record<string, string>,
): Promise<void> {
	Platform.isWin = false;
	try {
		for (const [path, text] of Object.entries(files)) {
			session.adapter.putText(path, text);
		}
		const result = await session.compare();
		await pushPathsOp(
			session.deps(),
			result,
			Object.keys(files),
			session.context(),
		);
	} finally {
		Platform.isWin = true;
	}
}

describe("two remote spellings of one path on a case-insensitive disk", () => {
	it("keeps the one this device has and skips the other", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("note.md", "mine\n");
		await pushPathsOp(a.deps(), await a.compare(), ["note.md"], a.context());
		await pushFromLinux(b, { "Note.md": "theirs\n" });

		const result = await a.compare();

		expect(result.diff.remoteChanges).toEqual([]);
		expect(result.snapshot.skipped).toEqual([
			{ path: "Note.md", reason: "case-clash", other: "note.md" },
		]);
		const pushed = await pushPathsOp(
			a.deps(),
			result,
			["note.md"],
			a.context(),
		);
		expect(Object.keys(pushed.newRemote?.files ?? {}).sort()).toEqual([
			"Note.md",
			"note.md",
		]);
	});

	it("pulls only the first of two new spellings", async () => {
		const [a, b] = pairedSessions();
		await pushFromLinux(b, { "Note.md": "upper\n", "note.md": "lower\n" });

		const result = await a.compare();
		expect(result.diff.remoteChanges.map((c) => c.path)).toEqual(["Note.md"]);
		await pullPathsOp(a.deps(), result, ["Note.md"], a.context());

		expect(a.text("Note.md")).toBe("upper\n");
		expect(a.adapter.hasFile("note.md")).toBe(false);
	});
});

describe("remote names this disk refuses", () => {
	it("are skipped on Windows, the rest pulls and a push keeps them", async () => {
		const [a, b] = pairedSessions();
		await b.adapter.mkdir("empty?");
		await pushFromLinux(b, {
			"Q: why?.md": "q\n",
			"notes/ok.md": "ok\n",
			"why?/a.md": "a\n",
		});

		const result = await a.compare();
		expect(result.diff.remoteChanges.map((c) => c.path)).toEqual([
			"notes/ok.md",
		]);
		expect(result.snapshot.skipped.map(({ path }) => path).sort()).toEqual([
			"Q: why?.md",
			"why?/a.md",
		]);
		await pullPathsOp(a.deps(), result, ["notes/ok.md"], a.context());
		expect(a.text("notes/ok.md")).toBe("ok\n");
		expect(await a.adapter.exists("empty?")).toBe(false);

		a.adapter.putText("mine.md", "m\n");
		const pushed = await pushPathsOp(
			a.deps(),
			await a.compare(),
			["mine.md"],
			a.context(),
		);
		expect(Object.keys(pushed.newRemote?.files ?? {})).toContain("Q: why?.md");
		expect(pushed.newRemote?.folders).toContain("empty?");
	});

	it("are skipped on Android, never on a Mac", async () => {
		const [a, b] = pairedSessions();
		await pushFromLinux(b, { "a|b.md": "x\n" });
		Platform.isWin = false;
		try {
			Platform.isAndroidApp = true;
			expect((await a.compare()).diff.remoteChanges).toEqual([]);
			Platform.isAndroidApp = false;
			Platform.isMacOS = true;
			const mac = await a.compare();
			expect(mac.diff.remoteChanges.map((c) => c.path)).toEqual(["a|b.md"]);
		} finally {
			Object.assign(Platform, {
				isWin: true,
				isAndroidApp: false,
				isMacOS: false,
			});
		}
	});
});

describe("a Finder folder icon an older build pushed", () => {
	it("stays remote, and no device lists it", async () => {
		const [a, b] = pairedSessions();
		b.adapter.putText("Icon\r", "");
		const loose = {
			...b.deps(),
			scope: { ...b.deps().scope, includes: () => true },
		};
		await pushPathsOp(loose, await compare(loose), ["Icon\r"], b.context());

		const mac = await b.compare();
		expect(mac.diff.localChanges).toEqual([]);
		expect(mac.diff.remoteChanges).toEqual([]);
		b.adapter.putText("note.md", "n\n");
		const pushed = await pushPathsOp(
			b.deps(),
			await b.compare(),
			["note.md"],
			b.context(),
		);
		expect(Object.keys(pushed.newRemote?.files ?? {})).toContain("Icon\r");

		const other = await a.compare();
		expect(other.diff.remoteChanges.map((c) => c.path)).toEqual(["note.md"]);
		expect(other.snapshot.skipped).toEqual([]);
	});
});
