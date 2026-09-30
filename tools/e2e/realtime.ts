/**
 * The plugin's realtime link in a real Obsidian against a real relay, with a
 * scripted peer as the other device. `E2E_SOAK_MS` adds an idle stretch that
 * must not cost a reconnect (the hub answers keepalives without waking).
 */

import { createHash, randomBytes } from "node:crypto";

import { CHANNEL_DOC, deriveChannelGrant, EFrame } from "@obsync/protocol";

import { check, runScenario, sleep } from "./harness";
import { launchObsidian, type Obsidian } from "./obsidian";
import { connectPeer } from "./peer";
import { startRelay } from "./relay";

const RELAY_PORT = 8799;
const CDP_PORT = 9223;
const SECRET = "e2e-secret";
const STORAGE = {
	kind: "s3",
	// Unreachable on purpose: pulls are stubbed, only the channel matters.
	endpoint: "http://127.0.0.1:9",
	region: "auto",
	bucket: "e2e-bucket",
	prefix: "vault",
	accessKeyId: "e2e",
	secretAccessKey: "e2e",
	forcePathStyle: true,
	concurrency: 4,
} as const;
/** The plugin's vault channel: sha256 of `storageIdentity(STORAGE)`. */
const CHANNEL = createHash("sha256")
	.update(
		`s3|${STORAGE.endpoint}|${STORAGE.region}|${STORAGE.bucket}|${STORAGE.prefix}`,
	)
	.digest("hex");
const PEER = { id: "node-peer", name: "Node Peer" };
/** Stands in for the vault's frame key: presence is sealed under it. */
const FRAME_KEY = randomBytes(32);
const IV_BYTES = 12;
/** The plugin seals announcements for presence alone, as AES-GCM additional data. */
const PRESENCE = new TextEncoder().encode("presence");
/** Longer than two reconnect backoffs (2 s + 4 s). */
const REFUSED_SETTLE_MS = 7_000;
const SOAK_MS = Number(process.env.E2E_SOAK_MS ?? 0);

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

await runScenario("realtime e2e", async () => {
	const relay = await startRelay(RELAY_PORT, SECRET);
	let obsidian: Obsidian | null = null;
	try {
		obsidian = await launchObsidian({
			port: CDP_PORT,
			settings: {
				storageConfigs: { s3: STORAGE },
				activeStorageKind: "s3",
				realtimeSync: true,
				relayUrl: relay.url,
				relaySecret: SECRET,
			},
		});
		await scenario(obsidian, relay.url);
	} finally {
		await obsidian?.stop();
		relay.stop();
	}
});

async function scenario(obsidian: Obsidian, url: string): Promise<void> {
	await obsidian.waitFor(
		"plugin on the hub",
		() => app.plugins.plugins.obsync.realtime.hub.isConnected(),
		(connected) => connected,
	);
	await obsidian.evaluate(() => {
		const plugin = app.plugins.plugins.obsync;
		plugin.__pulls = 0;
		plugin.controller.refreshAndAutoPull = async () => {
			plugin.__pulls++;
		};
		const Native = window.WebSocket;
		plugin.__sockets = 0;
		window.WebSocket = class extends Native {
			constructor(...args: ConstructorParameters<typeof WebSocket>) {
				super(...args);
				plugin.__sockets++;
			}
		};
	});
	const counter = (name: "__pulls" | "__sockets") =>
		obsidian.evaluate((key) => app.plugins.plugins.obsync[key] as number, name);

	// The vault here has no passphrase: its frame key is handed in instead.
	await obsidian.evaluate(
		async (raw) => {
			const plugin = app.plugins.plugins.obsync;
			const key = new Uint8Array(raw);
			const frames = await crypto.subtle.importKey(
				"raw",
				key,
				"AES-GCM",
				false,
				["encrypt", "decrypt"],
			);
			const docIds = await crypto.subtle.importKey(
				"raw",
				key,
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			plugin.passphrase.liveKeys = () => ({ frames, docIds });
			plugin.realtime.refresh();
		},
		[...FRAME_KEY],
	);
	const frames = await crypto.subtle.importKey(
		"raw",
		FRAME_KEY,
		"AES-GCM",
		false,
		["encrypt", "decrypt"],
	);

	const grant = await deriveChannelGrant(SECRET, CHANNEL);
	const peer = await connectPeer(url, [[CHANNEL, grant]], PEER.id);
	const hello = await peer.next(EFrame.Peer);
	const me = await obsidian.evaluate(() =>
		app.plugins.plugins.obsync.controller.currentDevice(),
	);
	check(
		"the relay sees no device name",
		new TextDecoder().decode(hello.payload).includes(me.name),
		false,
	);
	const { key, name } = (await opened(frames, hello.payload)) as {
		key: string;
		name: string;
	};
	check(
		"plugin announces itself, sealed, to a newcomer",
		{ key, name },
		{ key: me.id, name: me.name },
	);

	peer.send({
		type: EFrame.Awareness,
		slot: 0,
		doc: CHANNEL_DOC,
		payload: await sealed(frames, {
			key: PEER.id,
			name: PEER.name,
			note: null,
			idle: false,
		}),
	});
	await obsidian.waitFor(
		"peer in the device list",
		() => app.plugins.plugins.obsync.realtime.people.devices().devices,
		(devices: { id: string }[]) =>
			devices.some((device) => device.id === PEER.id),
	);

	peer.signal();
	await obsidian.waitFor(
		"a pull after a remote signal",
		() => app.plugins.plugins.obsync.__pulls,
		(pulls: number) => pulls > 0,
	);
	check("remote signals debounce into one pull", await counter("__pulls"), 1);

	await obsidian.evaluate(() =>
		app.plugins.plugins.obsync.realtime.hub.signal("vault"),
	);
	await peer.next(EFrame.Signal);

	if (SOAK_MS > 0) {
		await sleep(SOAK_MS);
		check("idle link survives the soak", await counter("__sockets"), 0);
		peer.signal();
		await obsidian.waitFor(
			"a pull after the soak",
			() => app.plugins.plugins.obsync.__pulls,
			(pulls: number) => pulls === 2,
		);
	}

	peer.close();
	await obsidian.waitFor(
		"peer gone from the device list",
		() => app.plugins.plugins.obsync.realtime.people.devices().devices,
		(devices: unknown[]) => devices.length === 0,
	);

	const original = await obsidian.evaluate(() => {
		const plugin = app.plugins.plugins.obsync;
		const secret = plugin.settings.relaySecret;
		plugin.settings.relaySecret = "wrong-secret";
		plugin.realtime.hub.restartIfChanged();
		return secret as string;
	});
	await obsidian.waitFor(
		"link down on a refused grant",
		() => app.plugins.plugins.obsync.realtime.hub.isConnected(),
		(connected) => !connected,
	);
	await sleep(REFUSED_SETTLE_MS);
	// A fresh share token can be refused while KV catches up: a few retries, backing off.
	const refused = await counter("__sockets");
	check("a refused grant backs off", refused >= 2 && refused <= 4, true);

	const watcher = await connectPeer(url, [[CHANNEL, grant]], PEER.id);
	await obsidian.evaluate((secret) => {
		const plugin = app.plugins.plugins.obsync;
		plugin.settings.relaySecret = secret;
		plugin.realtime.hub.restartIfChanged();
	}, original);
	await watcher.next(EFrame.Join);
	await watcher.next(EFrame.Peer);
	watcher.close();
	console.log("ok   fixed settings reconnect and re-announce");
}

async function sealed(key: CryptoKey, value: unknown): Promise<Uint8Array> {
	const iv = randomBytes(IV_BYTES);
	const body = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: PRESENCE },
			key,
			new TextEncoder().encode(JSON.stringify(value)),
		),
	);
	const frame = new Uint8Array(IV_BYTES + body.length);
	frame.set(iv);
	frame.set(body, IV_BYTES);
	return frame;
}

async function opened(key: CryptoKey, frame: Uint8Array): Promise<unknown> {
	const plain = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: frame.subarray(0, IV_BYTES) as BufferSource,
			additionalData: PRESENCE,
		},
		key,
		frame.subarray(IV_BYTES) as BufferSource,
	);
	return JSON.parse(new TextDecoder().decode(plain));
}
