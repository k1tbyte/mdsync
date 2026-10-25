import { joined, record } from "@tests/helpers/space-records";
import { describe, expect, it, vi } from "vitest";

import type { PassphraseManager } from "@/core/passphrase-manager";
import {
	createSessionOpeners,
	type SessionFactoryDeps,
} from "@/core/session-factory";
import type { StatePersister } from "@/core/state-persister";
import { DEFAULT_SETTINGS, type MdsyncSettings } from "@/settings/model";
import type { SpaceRecord } from "@/spaces/record";
import { defaultS3Config } from "@/storage";
import type { Space } from "@/sync/space";

const SHARE: Space = { id: "team", root: "Team" };

function s3Settings(over: Partial<MdsyncSettings> = {}): MdsyncSettings {
	return {
		...DEFAULT_SETTINGS,
		storageConfigs: {
			...DEFAULT_SETTINGS.storageConfigs,
			[DEFAULT_SETTINGS.activeStorageKind]: {
				...defaultS3Config(),
				bucket: "b",
				accessKeyId: "k",
				secretAccessKey: "s",
			},
		},
		...over,
	};
}

function harness(settings: MdsyncSettings, records: SpaceRecord[] = []) {
	const passphrase = {
		prompt: vi.fn(async () => true),
		resolveKey: vi.fn(),
		forget: vi.fn(),
	};
	const logs = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
	const notify = vi.fn();
	const onNoStorage = vi.fn();
	const deps = {
		app: {
			vault: {
				adapter: { read: vi.fn(async () => "") },
				configDir: ".obsidian",
				getAbstractFileByPath: () => null,
			},
		},
		settings,
		spaces: { get: (id: string) => records.find((each) => each.id === id) },
		passphrase: passphrase as unknown as PassphraseManager,
		state: {
			state: { deviceId: "d", storages: {}, hashCache: {} },
		} as unknown as StatePersister,
		logs: logs as unknown as SessionFactoryDeps["logs"],
		notify,
		onNoStorage,
	} as unknown as SessionFactoryDeps;
	return { deps, passphrase, logs, notify, onNoStorage };
}

describe("openLocal", () => {
	it("opens the vault without a passphrase, a key, a log or a notice", async () => {
		const h = harness(s3Settings());
		const local = await createSessionOpeners(h.deps).openLocal(
			{ id: "", root: "" },
			[],
		);

		expect(local).toMatchObject({
			space: { root: "" },
			maxFileBytes: DEFAULT_SETTINGS.maxFileBytes,
			state: { deviceId: "d", baseline: null },
		});
		expect(local?.scope.includes("note.md")).toBe(true);
		expect(h.passphrase.prompt).not.toHaveBeenCalled();
		expect(h.passphrase.resolveKey).not.toHaveBeenCalled();
		expect(h.logs.warn).not.toHaveBeenCalled();
		expect(h.notify).not.toHaveBeenCalled();
		expect(h.onNoStorage).not.toHaveBeenCalled();
	});

	it("answers null for a vault without storage, quietly where the session would prompt", async () => {
		const h = harness(DEFAULT_SETTINGS);
		expect(
			await createSessionOpeners(h.deps).openLocal({ id: "", root: "" }, []),
		).toBeNull();
		expect(h.logs.warn).not.toHaveBeenCalled();
		expect(h.onNoStorage).not.toHaveBeenCalled();
		expect(h.passphrase.prompt).not.toHaveBeenCalled();
	});

	it("opens a share its record and storage allow", async () => {
		const h = harness(s3Settings(), [record("team", "Team")]);
		const local = await createSessionOpeners(h.deps).openLocal(SHARE, [SHARE]);
		expect(local?.space).toBe(SHARE);
		expect(local?.scope.includes("Team/a.md")).toBe(true);
		expect(h.passphrase.resolveKey).not.toHaveBeenCalled();
	});

	it("answers null for a share without a record, paused, or without S3 storage", async () => {
		const open = (settings: MdsyncSettings, records: SpaceRecord[]) =>
			createSessionOpeners(harness(settings, records).deps).openLocal(SHARE, [
				SHARE,
			]);

		expect(await open(s3Settings(), [])).toBeNull();
		expect(
			await open(s3Settings({ pausedSpaces: ["team"] }), [
				record("team", "Team"),
			]),
		).toBeNull();
		expect(
			await open(s3Settings(), [{ ...record("team", "Team"), paused: true }]),
		).toBeNull();
		// An owner's share needs the device's S3 credentials.
		expect(await open(DEFAULT_SETTINGS, [record("team", "Team")])).toBeNull();
	});

	it("opens a joined share even without vault storage", async () => {
		const h = harness(DEFAULT_SETTINGS, [joined("team", "Team")]);
		expect(
			await createSessionOpeners(h.deps).openLocal(SHARE, [SHARE]),
		).not.toBeNull();
	});

	it("builds the scope the session opener builds", async () => {
		const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
		const h = harness(s3Settings(), [{ ...record("team", "Team"), key }]);
		const other: Space = { id: "other", root: "Team/Inner" };
		const partition = [{ id: "", root: "" }, SHARE, other];

		const local = await createSessionOpeners(h.deps).openLocal(
			SHARE,
			partition,
		);
		const session = await createSessionOpeners(h.deps).openSession(
			SHARE,
			partition,
		);

		for (const path of ["Team/a.md", "Team/Inner/b.md", "Elsewhere/c.md"]) {
			expect(local?.scope.includes(path)).toBe(session?.scope.includes(path));
		}
		expect(local?.scope.includes("Team/Inner/b.md")).toBe(false);
		expect(local?.state).toEqual(session?.state);
	});
});
