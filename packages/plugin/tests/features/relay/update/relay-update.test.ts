import type { Plugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/app/host";
import { mergeSettings } from "@/app/settings";
import type { HubListener } from "@/core/hub";
import { RELAY_VERSION } from "@/features/relay/deploy/relay-account";
import { testRelay } from "@/features/relay/relay-test";
import {
	type RelayUpdate,
	registerRelayUpdate,
} from "@/features/relay/update/relay-update";
import { openRelayUpdateModal } from "@/features/relay/update/relay-update-modal";

vi.mock("@/features/relay/update/relay-update-modal", () => ({
	openRelayUpdateModal: vi.fn(async () => false),
}));
vi.mock("@/features/relay/relay-test", () => ({
	testRelay: vi.fn(),
}));
vi.mock("@/features/relay/deploy/relay-account", async (original) => ({
	...(await original<typeof import("@/features/relay/deploy/relay-account")>()),
	accountRelays: async () => ({
		taken: ["mdsync-relay", "mdsync-relay-2"],
		subdomain: "me",
	}),
}));

const RELAY_URL = "https://mdsync-relay.me.workers.dev";
const flush = () => new Promise((resolve) => setTimeout(resolve));

/** One launch over a device's local storage: its socket connecting and the update it found. */
function launch(
	storage: Map<string, unknown>,
	overrides: Record<string, string> = {},
): {
	connect: () => Promise<void>;
	update: RelayUpdate;
	settings: PluginHost["settings"];
} {
	let listener: HubListener = {};
	const plugin = {
		settings: mergeSettings({
			relayUrl: RELAY_URL,
			relaySecret: "secret",
			cloudflareToken: "token",
			cloudflareAccountId: "acc",
			...overrides,
		}),
		app: {
			loadLocalStorage: (key: string) => storage.get(key) ?? null,
			saveLocalStorage: (key: string, value: unknown) =>
				storage.set(key, value),
		},
		realtime: {
			hub: {
				listen: (l: HubListener) => {
					listener = l;
					return () => {};
				},
			},
		},
		register: () => {},
	} as unknown as Plugin & PluginHost;
	const update = registerRelayUpdate(plugin);
	const connect = async () => {
		listener.onConnectionChange?.(true);
		await flush();
	};
	return { connect, update, settings: plugin.settings };
}

function relayRuns(version: string | null): void {
	vi.mocked(testRelay).mockResolvedValue({ ok: true, message: "", version });
}

describe("registerRelayUpdate", () => {
	beforeEach(() => {
		vi.mocked(openRelayUpdateModal).mockClear();
		vi.mocked(testRelay).mockReset();
	});

	it("offers an outdated own relay once per launch; not now holds across launches", async () => {
		relayRuns("1.2.0+old");
		const storage = new Map<string, unknown>();
		const { connect, update } = launch(storage);
		await connect();
		await connect();
		expect(openRelayUpdateModal).toHaveBeenCalledTimes(1);
		expect(vi.mocked(openRelayUpdateModal).mock.calls[0]?.[2]).toEqual({
			name: "mdsync-relay",
			secret: "secret",
		});
		expect(update.ready()).toBe(true);
		const next = launch(storage);
		await next.connect();
		expect(openRelayUpdateModal).toHaveBeenCalledTimes(1);
		expect(next.update.ready()).toBe(true);
	});

	it("opens one window when asked again while it is open", async () => {
		relayRuns("1.2.0+old");
		const storage = new Map<string, unknown>([
			["mdsync-relay-update-skipped", RELAY_VERSION],
		]);
		const { connect, update } = launch(storage);
		await connect();
		await Promise.all([update.offer(), update.offer()]);
		expect(openRelayUpdateModal).toHaveBeenCalledTimes(1);
	});

	it("keeps each relay's update across a switch and back", async () => {
		relayRuns("1.2.0+old");
		const { connect, update, settings } = launch(new Map());
		await connect();
		settings.relayUrl = "https://mdsync-relay-2.me.workers.dev";
		expect(update.ready()).toBe(false);
		await connect();
		expect(update.ready()).toBe(true);
		settings.relayUrl = RELAY_URL;
		expect(update.ready()).toBe(true);
	});

	it("offers nothing for a relay secret edited since the check", async () => {
		relayRuns("1.2.0+old");
		const { connect, update, settings } = launch(new Map());
		await connect();
		settings.relaySecret = "typo";
		expect(update.ready()).toBe(false);
	});

	it("takes a new secret the outdated relay accepted on reconnect", async () => {
		relayRuns("1.2.0+old");
		const { connect, update, settings } = launch(new Map());
		await connect();
		settings.relaySecret = "rotated";
		expect(update.ready()).toBe(false);
		await connect();
		expect(update.ready()).toBe(true);
		expect(openRelayUpdateModal).toHaveBeenCalledTimes(1);
	});

	it("offers nothing once the Cloudflare token is forgotten", async () => {
		relayRuns("1.2.0+old");
		const { connect, update, settings } = launch(new Map());
		await connect();
		settings.cloudflareToken = "";
		expect(update.ready()).toBe(false);
		await update.offer();
		expect(openRelayUpdateModal).toHaveBeenCalledTimes(1);
	});

	it("clears a pending update once the relay reconnects current", async () => {
		relayRuns("1.2.0+old");
		const { connect, update } = launch(new Map());
		await connect();
		const changed = vi.fn();
		update.subscribe(changed);
		relayRuns(RELAY_VERSION);
		await connect();
		expect(update.ready()).toBe(false);
		expect(changed).toHaveBeenCalledOnce();
	});

	it.each([
		["no Cloudflare token here", { cloudflareToken: "" }, "1.2.0+old"],
		["the relay is current", {}, RELAY_VERSION],
		["the relay is newer", {}, "9.0.0+new"],
		["it was deployed outside MDSync", {}, null],
		[
			"another account runs it",
			{ relayUrl: "https://relay.example" },
			"1.2.0+old",
		],
	])("stays silent when %s", async (_, overrides, version) => {
		relayRuns(version);
		const { connect, update } = launch(new Map(), overrides);
		await connect();
		expect(openRelayUpdateModal).not.toHaveBeenCalled();
		expect(update.ready()).toBe(false);
	});
});
