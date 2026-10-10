import { describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/plugin/host";
import { type MdsyncSettings, mergeSettings } from "@/settings/model";
import {
	ESetupPath,
	ESetupStep,
	firstStep,
	isStepDone,
	PATH_STEPS,
} from "@/settings/setup/steps";
import type { SpaceRecord } from "@/spaces/record";
import { defaultS3Config, EStorageBackend } from "@/storage";

const STORAGE = {
	storageConfigs: {
		[EStorageBackend.S3]: {
			...defaultS3Config(),
			bucket: "vault",
			accessKeyId: "key",
			secretAccessKey: "secret",
		},
	},
};
const RELAY = { relayUrl: "https://relay.example", relaySecret: "secret" };

function host(
	settings: Partial<MdsyncSettings> = {},
	unlocked = false,
	has = false,
): PluginHost {
	return {
		settings: mergeSettings(settings),
		passphrase: {
			isUnlocked: vi.fn(() => unlocked),
			has: vi.fn(() => has),
		},
	} as unknown as PluginHost;
}

describe("setup paths", () => {
	it("sets up storage and passphrase on a new device but imports them on a joining device", () => {
		expect(PATH_STEPS[ESetupPath.New]).toEqual([
			ESetupStep.Storage,
			ESetupStep.Passphrase,
			ESetupStep.Relay,
			ESetupStep.Ready,
		]);
		expect(PATH_STEPS[ESetupPath.Join]).toEqual([
			ESetupStep.Import,
			ESetupStep.Relay,
			ESetupStep.Ready,
		]);
	});
});

describe("isStepDone", () => {
	it("requires the active storage backend to be configured", () => {
		expect(isStepDone(host(), ESetupStep.Storage)).toBe(false);
		expect(isStepDone(host(STORAGE), ESetupStep.Storage)).toBe(true);
		const plugin = host(STORAGE);
		plugin.settings.storageConfigs[EStorageBackend.WebDAV] = {
			kind: EStorageBackend.WebDAV,
			baseUrl: "",
			basePath: "",
			username: "",
			password: "",
			concurrency: 4,
		};
		plugin.settings.activeStorageKind = EStorageBackend.WebDAV;
		expect(isStepDone(plugin, ESetupStep.Storage)).toBe(false);
	});

	it.each([
		[false, false, false],
		[false, true, false],
		[true, false, true],
		[true, true, true],
	] as const)(
		"requires an unlocked passphrase, not just a saved one: unlocked=%s, has=%s",
		(unlocked, has, done) => {
			expect(isStepDone(host({}, unlocked, has), ESetupStep.Passphrase)).toBe(
				done,
			);
		},
	);

	it.each([
		[false, false, false],
		[false, true, false],
		[true, false, false],
		[true, true, true],
	] as const)(
		"requires both sync access and a passphrase for import: storage=%s, has=%s",
		(storage, has, done) => {
			const plugin = host(storage ? STORAGE : {}, false, has);
			expect(isStepDone(plugin, ESetupStep.Import)).toBe(done);
		},
	);

	it("accepts an imported participant share without vault storage", () => {
		const plugin = host({}, false, true);
		const share: SpaceRecord = {
			id: "share",
			name: "Team",
			root: "Team",
			rev: 1,
			author: "owner",
			key: "key",
			access: {
				kind: "participant",
				relayUrl: "https://relay.example",
				token: "token",
				participantId: "participant",
				personName: "Guest",
			},
		};
		plugin.settings.spaces = [share];
		expect(isStepDone(plugin, ESetupStep.Import)).toBe(true);
		expect(isStepDone(plugin, ESetupStep.Storage)).toBe(false);
		share.closed = true;
		expect(isStepDone(plugin, ESetupStep.Import)).toBe(false);
	});

	it.each([
		["", "", false],
		[RELAY.relayUrl, "", false],
		["", RELAY.relaySecret, false],
		[RELAY.relayUrl, RELAY.relaySecret, true],
	] as const)(
		"requires both relay URL and secret: URL=%s, secret=%s",
		(relayUrl, relaySecret, done) => {
			const plugin = host({ relayUrl, relaySecret, realtimeSync: false });
			expect(isStepDone(plugin, ESetupStep.Relay)).toBe(done);
		},
	);

	it.each([ESetupStep.Start, ESetupStep.Ready])(
		"needs no configuration for %s",
		(step) => {
			expect(isStepDone(host(), step)).toBe(true);
		},
	);
});

describe("firstStep", () => {
	it("opens Start without storage even when the passphrase and relay are ready", () => {
		expect(firstStep(host())).toBe(ESetupStep.Start);
		expect(firstStep(host(RELAY, true, true))).toBe(ESetupStep.Start);
	});

	it("opens Passphrase after storage until the passphrase is unlocked", () => {
		expect(firstStep(host(STORAGE))).toBe(ESetupStep.Passphrase);
		expect(firstStep(host({ ...STORAGE, ...RELAY }, false, true))).toBe(
			ESetupStep.Passphrase,
		);
	});

	it("opens Relay after storage and an unlocked passphrase", () => {
		expect(firstStep(host(STORAGE, true, true))).toBe(ESetupStep.Relay);
		expect(
			firstStep(host({ ...STORAGE, relayUrl: RELAY.relayUrl }, true, true)),
		).toBe(ESetupStep.Relay);
	});

	it("opens Ready with storage, an unlocked passphrase and relay credentials", () => {
		expect(firstStep(host({ ...STORAGE, ...RELAY }, true, true))).toBe(
			ESetupStep.Ready,
		);
	});

	it("recomputes the opening step as settings and passphrase state change", () => {
		const plugin = host();
		expect(firstStep(plugin)).toBe(ESetupStep.Start);
		plugin.settings.storageConfigs = STORAGE.storageConfigs;
		expect(firstStep(plugin)).toBe(ESetupStep.Passphrase);
		vi.mocked(plugin.passphrase.isUnlocked).mockReturnValue(true);
		expect(firstStep(plugin)).toBe(ESetupStep.Relay);
		Object.assign(plugin.settings, RELAY);
		expect(firstStep(plugin)).toBe(ESetupStep.Ready);
		vi.mocked(plugin.passphrase.isUnlocked).mockReturnValue(false);
		expect(firstStep(plugin)).toBe(ESetupStep.Passphrase);
	});
});
