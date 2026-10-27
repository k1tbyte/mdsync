import {
	failure,
	fakeCloudflare,
	type Reply,
	type Route,
	readForm,
} from "@tests/helpers/fake-cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/app/host";
import { mergeSettings } from "@/app/settings";
import {
	activateRelay,
	deployOwnRelay,
	failedRelay,
	planRelay,
	runningRelayDeploy,
	useRelay,
	waitForRelay,
} from "@/features/relay/deploy/deploy-flow";
import {
	RELAY_NAME,
	RELAY_VERSION,
} from "@/features/relay/deploy/relay-account";
import { ERelayDeployStep } from "@/features/relay/deploy/relay-deploy";
import { testRelay } from "@/features/relay/relay-test";

vi.mock("@/features/relay/relay-test", () => ({
	testRelay: vi.fn(),
}));

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

describe("planRelay", () => {
	const NONE = { relayUrl: "", relaySecret: "" };

	it("updates this device's relay with its saved secret when it answers", async () => {
		vi.mocked(testRelay).mockResolvedValue({ ok: true, message: "" });

		expect(await planRelay(RELAYS, RELAY)).toEqual({
			deploy: { name: RELAY_NAME, secret: "secret" },
		});
	});

	it("asks for the secret when the saved one does not get an answer", async () => {
		vi.mocked(testRelay).mockResolvedValue({ ok: false, message: "timeout" });

		expect(await planRelay(RELAYS, RELAY)).toEqual({ ask: RELAY_NAME });
	});

	it("repeats the deploy that just failed with its own secret, without asking", async () => {
		const failed = { name: RELAY_NAME, secret: "chosen-here" };

		expect(await planRelay(RELAYS, RELAY, failed)).toEqual({ deploy: failed });
		expect(testRelay).not.toHaveBeenCalled();
	});

	it("deploys the default relay with a fresh secret on an account without one", async () => {
		const plan = await planRelay({ taken: ["other"], subdomain: "me" }, NONE);

		if (!("deploy" in plan)) throw new Error("expected a deploy");
		expect(plan.deploy.name).toBe(RELAY_NAME);
		expect(plan.deploy.secret).not.toBe("");
		expect(testRelay).not.toHaveBeenCalled();
	});

	it("asks before touching a default-named worker this device does not know", async () => {
		expect(await planRelay(RELAYS, NONE)).toEqual({ ask: RELAY_NAME });
	});

	it("offers no update for a relay that is not on the account", async () => {
		const elsewhere = { relayUrl: "https://relay.example", relaySecret: "s" };

		expect(await planRelay(RELAYS, elsewhere)).toEqual({ ask: null });
		expect(testRelay).not.toHaveBeenCalled();
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
			text: RELAY_VERSION,
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

	it("keeps a broken-off deploy for its own account until one succeeds", async () => {
		const plugin = host();
		let fail = true;
		const cf = fakeCloudflare(
			deployRoutes(RELAY_NAME, () => (fail ? failure(10005) : { result: {} })),
		);
		const login = { api: cf.api, accountId: "acc" };
		const target = { name: RELAY_NAME, secret: "generated" };

		await expect(
			deployOwnRelay(plugin, login, target, vi.fn()),
		).rejects.toThrow(/10005/);
		expect(failedRelay("acc")).toEqual(target);
		expect(failedRelay("other")).toBeNull();
		expect(plugin.settings).toMatchObject({ relayUrl: "", relaySecret: "" });

		fail = false;
		await deployOwnRelay(plugin, login, target, vi.fn());
		expect(failedRelay("acc")).toBeNull();
	});

	it("exposes the running deploy until it settles", async () => {
		const cf = fakeCloudflare(deployRoutes());
		const login = { api: cf.api, accountId: "acc" };
		const running = deployOwnRelay(
			host(),
			login,
			{ name: RELAY_NAME, secret: "s" },
			vi.fn(),
		);
		expect(runningRelayDeploy()).toBe(running);
		await running;
		expect(runningRelayDeploy()).toBeNull();
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

const KEEP_WAITING = () => true;

describe("waitForRelay", () => {
	it("returns immediately when the relay already runs the bundled version", async () => {
		vi.useFakeTimers();
		vi.mocked(testRelay).mockResolvedValue({
			ok: true,
			message: "ready",
			version: RELAY_VERSION,
		});
		expect(await waitForRelay(RELAY, KEEP_WAITING)).toBe(true);
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
		const waiting = waitForRelay(RELAY, KEEP_WAITING);
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
			const waiting = waitForRelay(RELAY, KEEP_WAITING);
			await vi.advanceTimersByTimeAsync(180_000);
			expect(await waiting).toBe(false);
			expect(testRelay).toHaveBeenCalledTimes(61);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});

describe("waitForRelay stopping", () => {
	it("stops polling once told to, without another request", async () => {
		vi.useFakeTimers();
		vi.mocked(testRelay).mockResolvedValue({ ok: false, message: "offline" });
		let open = true;
		const waiting = waitForRelay(RELAY, () => open);
		await vi.advanceTimersByTimeAsync(0);
		expect(testRelay).toHaveBeenCalledTimes(1);
		open = false;
		await vi.advanceTimersByTimeAsync(3000);
		expect(await waiting).toBe(false);
		expect(testRelay).toHaveBeenCalledTimes(1);
	});
});

describe("activateRelay", () => {
	it("waits once and switches the relay on once however many wizards ask", async () => {
		vi.useFakeTimers();
		vi.mocked(testRelay).mockResolvedValue({
			ok: true,
			message: "ready",
			version: RELAY_VERSION,
		});
		const plugin = host();

		const answers = await Promise.all([
			activateRelay(plugin),
			activateRelay(plugin),
		]);

		expect(answers).toEqual([true, true]);
		expect(testRelay).toHaveBeenCalledTimes(1);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(plugin.realtime.hub.restart).toHaveBeenCalledTimes(1);
	});

	it("gives up without switching anything on once the plugin is unloaded", async () => {
		const plugin = Object.assign(host(), { unloaded: true });

		expect(await activateRelay(plugin)).toBe(false);
		expect(testRelay).not.toHaveBeenCalled();
		expect(plugin.saveSettings).not.toHaveBeenCalled();
	});
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
