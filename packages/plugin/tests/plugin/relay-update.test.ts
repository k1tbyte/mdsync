import type { Plugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_VERSION } from "@/cloudflare";
import type { HubListener } from "@/hub/connection";
import type { PluginHost } from "@/plugin/host";
import { registerRelayUpdate } from "@/plugin/relay-update";
import { testRelay } from "@/settings/connection-test";
import { mergeSettings } from "@/settings/model";
import { openRelayUpdateModal } from "@/ui";

vi.mock("@/ui", () => ({ openRelayUpdateModal: vi.fn(async () => false) }));
vi.mock("@/settings/connection-test", () => ({ testRelay: vi.fn() }));
vi.mock("@/cloudflare", async (original) => ({
	...(await original<typeof import("@/cloudflare")>()),
	accountRelays: async () => ({ taken: ["mdsync-relay"], subdomain: "me" }),
}));

const RELAY_URL = "https://mdsync-relay.me.workers.dev";
const flush = () => new Promise((resolve) => setTimeout(resolve));

/** One launch over a device's local storage; returns its socket connecting. */
function launch(
	storage: Map<string, unknown>,
	overrides: Record<string, string> = {},
): () => Promise<void> {
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
	registerRelayUpdate(plugin);
	return async () => {
		listener.onConnectionChange?.(true);
		await flush();
	};
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
		const connect = launch(storage);
		await connect();
		await connect();
		expect(openRelayUpdateModal).toHaveBeenCalledTimes(1);
		expect(vi.mocked(openRelayUpdateModal).mock.calls[0]?.[2]).toEqual({
			name: "mdsync-relay",
			secret: "secret",
		});
		await launch(storage)();
		expect(testRelay).toHaveBeenCalledTimes(1);
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
		await launch(new Map(), overrides)();
		expect(openRelayUpdateModal).not.toHaveBeenCalled();
	});
});
