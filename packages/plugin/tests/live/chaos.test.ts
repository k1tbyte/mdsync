import { LiveHub, type TestConnection } from "@tests/helpers/live-hub";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveLiveKeys } from "@/crypto/live-keys";
import { docIdFor } from "@/live/seal";
import { LiveSession } from "@/live/session";
import { TEXT, type TextModel } from "@/live/text/model";

const FLUSHED_MS = 300;
const DEVICES = 3;
const ROUNDS = 6;
const ACTIONS_PER_ROUND = 10;
const SEEDS = 3;

interface Device {
	connection: TestConnection;
	session: LiveSession<TextModel>;
}

const sessions: LiveSession<TextModel>[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function roomOf(hub: LiveHub) {
	const keys = await deriveLiveKeys(crypto.getRandomValues(new Uint8Array(32)));
	const docId = await docIdFor(keys, "note.md", 0);
	return async (disk: string): Promise<Device> => {
		const connection = hub.connection();
		connection.connect();
		const session = new LiveSession(docId, 0, {
			kind: TEXT,
			keys,
			hub: connection,
			author: { person: "owner", name: "Laptop" },
			successor: () => docIdFor(keys, "note.md", 1),
			readDisk: async () => disk,
			readBase: async () => disk,
			onAgreed: () => {},
			onMoved: () => {},
			onRefused: () => {},
		});
		sessions.push(session);
		await session.ready;
		return { connection, session };
	};
}

const textOf = ({ session }: Device) => session.model.text.toString();

describe("live rooms under chaos", () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		it(`converge without losing an edit (seed ${seed})`, async () => {
			const next = seeded(seed);
			const hub = new LiveHub();
			const open = await roomOf(hub);
			const devices = await Promise.all(
				Array.from({ length: DEVICES }, () => open("start\n")),
			);
			const typed: string[] = [];
			const reconnect = ({ connection }: Device) => {
				connection.disconnect();
				connection.connect();
			};
			const actions: ((device: Device) => void)[] = [
				...Array.from({ length: 6 }, () => (device: Device) => {
					const token = String.fromCharCode(0xe000 + typed.length);
					typed.push(token);
					const { text } = device.session.model;
					text.insert(Math.floor(next() * (text.length + 1)), token);
				}),
				reconnect,
				({ connection }) => connection.dropIncoming(),
				({ connection }) => connection.dropOutgoing(),
				({ connection }) => connection.disconnect(),
				({ connection }) => connection.connect(),
			];
			const pick = <T>(items: T[]): T =>
				items[Math.floor(next() * items.length)] as T;

			for (let round = 0; round < ROUNDS; round++) {
				for (let i = 0; i < ACTIONS_PER_ROUND; i++) {
					pick(actions)(pick(devices));
				}
				await sleep(next() < 0.5 ? FLUSHED_MS : 20);
			}

			for (const device of devices) reconnect(device);
			await vi.waitFor(
				() => {
					const [first, ...rest] = devices.map(textOf);
					expect(rest.every((text) => text === first)).toBe(true);
					expect(devices.every(({ session }) => session.settled)).toBe(true);
				},
				{ timeout: 5000 },
			);
			const final = textOf(devices[0] as Device);
			for (const token of typed) {
				expect(final.split(token).length - 1, token).toBe(1);
			}
			expect(textOf(await open(""))).toBe(final);
		}, 30000);
	}
});
