import {
	failure,
	fakeCloudflare,
	type Reply,
	type Route,
	readForm,
} from "@tests/helpers/fake-cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ERelayDeployStep } from "@/cloudflare";
import type { PluginHost } from "@/plugin/host";
import { testRelay } from "@/settings/connection-test";
import { mergeSettings } from "@/settings/model";
import {
	accountRelays,
	deployOwnRelay,
	freeRelayName,
	ownRelayName,
	RELAY_NAME,
	RELAY_VERSION,
	relayNameError,
	relayUrlOf,
	useRelay,
	waitForRelay,
} from "@/settings/setup/relay";

vi.mock("@/settings/connection-test", () => ({ testRelay: vi.fn() }));

const A = "/accounts/acc";
const RELAYS = { taken: ["mdsync-relay", "other"], subdomain: "me" };
const RELAY = {
	relayUrl: "https://mdsync-relay.me.workers.dev",
	relaySecret: "secret",
};

function host(): PluginHost {
	return {
		settings: mergeSettings(null),
		saveSettings: vi.fn(async () => {}),
		realtime: { hub: { restart: vi.fn() } },
	} as unknown as PluginHost;
}

function deployRoutes(
	name = RELAY_NAME,
	upload: () => Reply = () => ({ result: { id: name } }),
	route: () => Reply = () => ({ result: { enabled: true } }),
): Route[] {
	const script = `${A}/workers/scripts/${name}`;
	return [
		{
			method: "GET",
			path: `${A}/workers/subdomain`,
			reply: () => ({ result: { subdomain: "me" } }),
		},
		{
			method: "GET",
			path: `${A}/workers/scripts`,
			reply: () => ({ result: [] }),
		},
		{
			method: "POST",
			path: `${script}/assets-upload-session`,
			reply: () => ({ result: { jwt: "done", buckets: [] } }),
		},
		{ method: "PUT", path: script, reply: upload },
		{ method: "POST", path: `${script}/subdomain`, reply: route },
	];
}

afterEach(() => {
	vi.useRealTimers();
	vi.mocked(testRelay).mockReset();
});

describe("accountRelays", () => {
	it("lists every worker name and the account's workers.dev subdomain", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/scripts`,
				reply: () => ({
					result: [{ id: "mdsync-relay" }, { id: "unrelated" }],
				}),
			},
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => ({ result: { subdomain: "me" } }),
			},
		]);
		expect(await accountRelays({ api: cf.api, accountId: "acc" })).toEqual({
			taken: ["mdsync-relay", "unrelated"],
			subdomain: "me",
		});
	});

	it("keeps worker names when the account has no workers.dev subdomain", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/scripts`,
				reply: () => ({ result: [{ id: "other" }] }),
			},
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => failure(10007, 404),
			},
		]);
		expect(await accountRelays({ api: cf.api, accountId: "acc" })).toEqual({
			taken: ["other"],
			subdomain: null,
		});
	});

	it("propagates account lookup failures", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/scripts`,
				reply: () => failure(10005),
			},
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => ({ result: { subdomain: "me" } }),
			},
		]);
		await expect(
			accountRelays({ api: cf.api, accountId: "acc" }),
		).rejects.toThrow(/10005/);
	});
});

describe("relay names and URLs", () => {
	it("builds the default or chosen worker URL only with a subdomain", () => {
		expect(relayUrlOf(RELAYS)).toBe(RELAY.relayUrl);
		expect(relayUrlOf(RELAYS, "other")).toBe("https://other.me.workers.dev");
		expect(relayUrlOf({ taken: [], subdomain: null })).toBeNull();
	});

	it.each([
		[RELAY.relayUrl, "mdsync-relay"],
		[`${RELAY.relayUrl}/status?x=1`, "mdsync-relay"],
		["https://other.me.workers.dev", "other"],
		["https://missing.me.workers.dev", null],
		["https://mdsync-relay.someone-else.workers.dev", null],
		["https://mdsync-relay.me.workers.dev.evil.test", null],
		["https://mdsync-relay.notme.workers.dev", null],
		["https://nested.mdsync-relay.me.workers.dev", null],
		["https://relay.example", null],
		["not a URL", null],
	] as const)("recognizes an owned worker for %s as %s", (url, name) => {
		expect(ownRelayName(RELAYS, url)).toBe(name);
	});

	it("cannot claim an owned worker without an account subdomain", () => {
		expect(
			ownRelayName({ ...RELAYS, subdomain: null }, RELAY.relayUrl),
		).toBeNull();
	});

	it.each([
		[[], "mdsync-relay"],
		[["unrelated", "mdsync-relay-2"], "mdsync-relay"],
		[["mdsync-relay"], "mdsync-relay-2"],
		[["mdsync-relay", "mdsync-relay-2", "mdsync-relay-4"], "mdsync-relay-3"],
	] as const)("chooses the first free relay name from %j", (taken, name) => {
		expect(freeRelayName(taken)).toBe(name);
	});

	it.each(["a", "0", "my-relay-2", "a".repeat(63)])(
		"accepts the available worker name %s",
		(name) => {
			expect(relayNameError(name, [])).toBeNull();
		},
	);

	it.each([
		"",
		"Relay",
		"my_relay",
		"my relay",
		"-relay",
		"relay-",
		"a.b",
		"é",
		"a".repeat(64),
	])("rejects the invalid worker name %s", (name) => {
		expect(relayNameError(name, [])).toBe(
			"Use lowercase letters, digits and dashes, up to 63.",
		);
	});

	it("rejects an existing worker name", () => {
		expect(relayNameError("other", RELAYS.taken)).toBe(
			"A worker with this name already exists.",
		);
	});
});

describe("deployOwnRelay", () => {
	it("saves the chosen worker URL and secret after upload and before enabling its route", async () => {
		const plugin = host();
		const name = "mdsync-relay-2";
		const cf = fakeCloudflare(
			deployRoutes(name, undefined, () => {
				expect(plugin.settings).toMatchObject({
					relayUrl: `https://${name}.me.workers.dev`,
					relaySecret: "kept-secret",
				});
				expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
				return { result: { enabled: true } };
			}),
		);
		vi.mocked(plugin.saveSettings).mockImplementation(async () => {
			expect(cf.paths().at(-1)).toBe(`PUT ${A}/workers/scripts/${name}`);
		});
		const onStep = vi.fn();

		await deployOwnRelay(
			plugin,
			{ api: cf.api, accountId: "acc" },
			{ name, secret: "kept-secret" },
			onStep,
		);

		expect(onStep.mock.calls.map(([step]) => step)).toEqual(
			Object.values(ERelayDeployStep),
		);
		expect(plugin.settings.realtimeSync).toBe(false);
		expect(plugin.realtime.hub.restart).not.toHaveBeenCalled();
		const upload = cf.calls.find((call) => call.method === "PUT");
		if (!upload) throw new Error("no script upload");
		const form = await readForm(upload);
		const metadata = JSON.parse(form.get("metadata") as string);
		expect(metadata.bindings).toContainEqual({
			type: "secret_text",
			name: "RELAY_SECRET",
			text: "kept-secret",
		});
		expect(metadata.bindings).toContainEqual({
			type: "plain_text",
			name: "RELAY_VERSION",
			text: "test-version",
		});
	});

	it("keeps the uploaded credentials when enabling the route fails and allows a retry", async () => {
		const plugin = host();
		Object.assign(plugin.settings, {
			relayUrl: "https://old.example",
			relaySecret: "old-secret",
		});
		let fail = true;
		const cf = fakeCloudflare(
			deployRoutes(RELAY_NAME, undefined, () => {
				expect(plugin.settings).toMatchObject(RELAY);
				expect(plugin.saveSettings).toHaveBeenCalled();
				return fail ? failure(10005) : { result: {} };
			}),
		);
		const login = { api: cf.api, accountId: "acc" };
		const target = { name: RELAY_NAME, secret: RELAY.relaySecret };

		await expect(
			deployOwnRelay(plugin, login, target, vi.fn()),
		).rejects.toThrow(/10005/);
		expect(plugin.settings).toMatchObject(RELAY);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		fail = false;
		await expect(
			deployOwnRelay(plugin, login, target, vi.fn()),
		).resolves.toBeUndefined();
	});

	it("leaves credentials unchanged when the worker upload fails and allows a retry", async () => {
		const plugin = host();
		let fail = true;
		const cf = fakeCloudflare(
			deployRoutes(RELAY_NAME, () => (fail ? failure(10005) : { result: {} })),
		);
		const login = { api: cf.api, accountId: "acc" };
		const target = { name: RELAY_NAME, secret: RELAY.relaySecret };

		await expect(
			deployOwnRelay(plugin, login, target, vi.fn()),
		).rejects.toThrow(/10005/);
		expect(plugin.settings).toMatchObject({ relayUrl: "", relaySecret: "" });
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(cf.paths()).not.toContain(
			`POST ${A}/workers/scripts/${RELAY_NAME}/subdomain`,
		);
		fail = false;
		await expect(
			deployOwnRelay(plugin, login, target, vi.fn()),
		).resolves.toBeUndefined();
	});

	it("refuses a concurrent deployment until the first deployment finishes saving", async () => {
		const plugin = host();
		const cf = fakeCloudflare(deployRoutes());
		const login = { api: cf.api, accountId: "acc" };
		const target = { name: RELAY_NAME, secret: RELAY.relaySecret };
		let release!: () => void;
		let uploaded!: () => void;
		const saving = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reachedSave = new Promise<void>((resolve) => {
			uploaded = resolve;
		});
		vi.mocked(plugin.saveSettings).mockImplementationOnce(async () => {
			uploaded();
			await saving;
		});
		const first = deployOwnRelay(plugin, login, target, vi.fn());
		try {
			await reachedSave;
			const calls = cf.calls.length;
			const onStep = vi.fn();
			await expect(
				deployOwnRelay(host(), login, target, onStep),
			).rejects.toThrow("The relay is still deploying. Wait a moment.");
			expect(onStep).not.toHaveBeenCalled();
			expect(cf.calls).toHaveLength(calls);
			expect(cf.paths()).not.toContain(
				`POST ${A}/workers/scripts/${RELAY_NAME}/subdomain`,
			);
		} finally {
			release();
			await first;
		}
		await expect(
			deployOwnRelay(plugin, login, target, vi.fn()),
		).resolves.toBeUndefined();
	});
});

describe("waitForRelay", () => {
	it("returns immediately when the relay already runs the bundled version", async () => {
		vi.useFakeTimers();
		vi.mocked(testRelay).mockResolvedValue({
			ok: true,
			message: "ready",
			version: RELAY_VERSION,
		});
		expect(await waitForRelay(RELAY)).toBe(true);
		expect(testRelay).toHaveBeenCalledTimes(1);
		expect(testRelay).toHaveBeenCalledWith(RELAY);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("polls every three seconds through connection failures and stale versions until ready", async () => {
		vi.useFakeTimers();
		vi.mocked(testRelay)
			.mockResolvedValueOnce({
				ok: false,
				message: "offline",
				version: RELAY_VERSION,
			})
			.mockResolvedValueOnce({
				ok: true,
				message: "old",
				version: "old-version",
			})
			.mockResolvedValueOnce({
				ok: true,
				message: "unversioned",
				version: null,
			})
			.mockResolvedValueOnce({
				ok: true,
				message: "ready",
				version: RELAY_VERSION,
			});
		const waiting = waitForRelay(RELAY);
		await vi.advanceTimersByTimeAsync(2999);
		expect(testRelay).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(testRelay).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(6000);
		expect(await waiting).toBe(true);
		expect(testRelay).toHaveBeenCalledTimes(4);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		{ ok: false, message: "offline" },
		{ ok: true, message: "stale", version: "old-version" },
		{ ok: true, message: "unversioned" },
	])(
		"stops after three minutes when the relay stays $message",
		async (status) => {
			vi.useFakeTimers();
			vi.mocked(testRelay).mockResolvedValue(status);
			const waiting = waitForRelay(RELAY);
			await vi.advanceTimersByTimeAsync(180_000);
			expect(await waiting).toBe(false);
			expect(testRelay).toHaveBeenCalledTimes(61);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});

describe("useRelay", () => {
	it("enables real-time sync and saves it before restarting the hub", async () => {
		const plugin = host();
		vi.mocked(plugin.saveSettings).mockImplementation(async () => {
			expect(plugin.settings.realtimeSync).toBe(true);
			expect(plugin.realtime.hub.restart).not.toHaveBeenCalled();
		});
		await useRelay(plugin);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(plugin.realtime.hub.restart).toHaveBeenCalledTimes(1);
	});

	it("does not restart the hub when saving fails", async () => {
		const plugin = host();
		vi.mocked(plugin.saveSettings).mockRejectedValueOnce(
			new Error("save failed"),
		);
		await expect(useRelay(plugin)).rejects.toThrow("save failed");
		expect(plugin.realtime.hub.restart).not.toHaveBeenCalled();
	});
});
