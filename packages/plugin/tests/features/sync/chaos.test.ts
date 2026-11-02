import { createTestControllerHost } from "@tests/helpers/controller";
import { FakeStorage } from "@tests/helpers/fake-storage";
import { killNextWrite } from "@tests/helpers/faults";
import { seeded } from "@tests/helpers/seeded";
import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncController } from "@/features/sync/controller";
import { WriteJournal } from "@/features/sync/recovery/journal";

useEncryptionKey();
afterEach(() => vi.restoreAllMocks());

const IDS = ["a", "b", "c"];
const NOTES = ["n0.md", "n1.md", "n2.md"];
const ROUNDS = 12;
const SEEDS = [1, 2, 3, 4, 5, 6];
const KILL_RATE = 0.3;
/** One section per device: appends at different points merge cleanly, so every one must survive. */
const SECTIONS = IDS.map((id) => `## ${id}`);
const isVaultFile = (path: string) => !path.startsWith(".obsidian/");

class Device {
	readonly session: TestSession;
	private readonly host: ReturnType<typeof createTestControllerHost>;
	private controller: SyncController;
	private killed: (() => boolean) | null = null;

	constructor(
		readonly id: string,
		storage: FakeStorage,
	) {
		this.session = new TestSession(`device-${id}`, storage);
		this.host = createTestControllerHost(this.session);
		this.controller = new SyncController(this.host);
	}

	/** A write dying part way kills the app: it restarts from its state and journal on disk, and syncs. */
	async sync(next: () => number): Promise<void> {
		if (!this.killed && next() < KILL_RATE) {
			const leaves = next() < 0.5 ? "prefix" : "nothing";
			this.killed = killNextWrite(this.session.adapter, isVaultFile, leaves);
		}
		await this.controller.refreshAndAutoSync();
		if (!this.killed?.()) return;
		vi.mocked(this.session.adapter.writeBinary).mockRestore();
		this.killed = null;
		this.controller.dispose();
		this.session.journal = await WriteJournal.load(
			this.session.adapter.asDataAdapter(),
			".obsidian",
		);
		this.controller = new SyncController(this.host);
		await this.controller.refreshAndAutoSync();
	}

	/** At the end of its own section, as typed here; false when the note is gone. */
	append(note: string, line: string): boolean {
		if (!this.session.adapter.hasFile(note)) return false;
		const lines = this.session.text(note).split("\n");
		const next = SECTIONS[IDS.indexOf(this.id) + 1];
		lines.splice(next ? lines.indexOf(next) : lines.length, 0, line);
		this.session.adapter.putText(note, lines.join("\n"));
		return true;
	}
}

describe("file sync chaos", () => {
	it.each(SEEDS)(
		"seed %i: writes killed part way lose and add nothing",
		async (seed) => {
			const next = seeded(seed);
			const storage = new FakeStorage();
			const devices = IDS.map((id) => new Device(id, storage));
			const [first] = devices as [Device];
			for (const note of NOTES)
				first.session.adapter.putText(note, SECTIONS.join("\n"));
			for (const device of devices) await device.sync(() => 1);
			const appended = new Map<string, string[]>(
				NOTES.map((note) => [note, []]),
			);

			for (let round = 0; round < ROUNDS; round++) {
				for (const device of devices) {
					await device.sync(next);
					const note = NOTES[Math.floor(next() * NOTES.length)] as string;
					const line = `${device.id}:${round}`;
					if (device.append(note, line)) appended.get(note)?.push(line);
				}
			}
			vi.restoreAllMocks();
			for (let pass = 0; pass < 3; pass++) {
				for (const device of devices) await device.sync(() => 1);
			}

			for (const note of NOTES) {
				const texts = new Set(
					devices.map((device) =>
						device.session.adapter.hasFile(note)
							? device.session.text(note)
							: "(gone)",
					),
				);
				expect(texts.size, `${note} differs between devices`).toBe(1);
				const lines = ([...texts][0] as string).split("\n");
				expect(
					lines.filter((line) => line.startsWith("## ")),
					note,
				).toEqual(SECTIONS);
				expect(
					lines.filter((line) => !line.startsWith("## ")).sort(),
					note,
				).toEqual(appended.get(note)?.sort());
			}
		},
	);
});
