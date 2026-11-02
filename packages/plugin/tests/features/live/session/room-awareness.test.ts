import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { deriveLiveKeys } from "@/core/crypto/live-keys";
import {
	ANNOUNCE_MS,
	RoomAwareness,
} from "@/features/live/session/room-awareness";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/** Steps run one at a time, as in a session's queue; `hold` backs it up until released. */
async function room() {
	let sent = 0;
	let queue: Promise<unknown> = Promise.resolve();
	let gate: Promise<void> = Promise.resolve();
	const presence = new RoomAwareness(new Y.Doc(), {
		keys: await deriveLiveKeys(crypto.getRandomValues(new Uint8Array(32))),
		docId: "doc",
		canSend: () => true,
		send: () => sent++,
		enqueue: (step) => {
			queue = queue.then(() => gate).then(step);
		},
	});
	return {
		presence,
		sent: () => sent,
		move: (head: number) =>
			presence.awareness.setLocalStateField("cursor", { head }),
		/** Advances the clock, then lets every queued step finish. */
		settle: async (ms: number) => {
			await vi.advanceTimersByTimeAsync(ms);
			await queue;
		},
		hold: () => {
			let release = () => {};
			gate = new Promise((resolve) => {
				release = resolve;
			});
			return () => {
				release();
				gate = Promise.resolve();
			};
		},
	};
}

describe("room awareness", () => {
	it("announces nothing while alone, heartbeat included, and itself to a newcomer at once", async () => {
		const { presence, sent, move, settle } = await room();

		move(1);
		await settle(20_000);
		expect(sent()).toBe(0);

		presence.joined(7);
		await settle(0);
		expect(sent()).toBe(1);
		presence.dispose();
	});

	it("sends a change at once after a quiet window, then once per window", async () => {
		const { presence, sent, move, settle } = await room();
		presence.joined(7);
		await settle(ANNOUNCE_MS);
		expect(sent()).toBe(1);

		move(1);
		await settle(0);
		expect(sent()).toBe(2);

		move(2);
		move(3);
		await settle(ANNOUNCE_MS - 1);
		expect(sent()).toBe(2);
		await settle(1);
		expect(sent()).toBe(3);
		presence.dispose();
	});

	it("keeps its pace however far back the clock is set", async () => {
		const { presence, sent, move, settle } = await room();
		presence.joined(7);
		await settle(0);

		vi.setSystemTime(Date.now() - 3_600_000);
		move(1);
		await settle(ANNOUNCE_MS);

		expect(sent()).toBe(2);
		presence.dispose();
	});

	it("sends a backed-up queue's changes once, as the latest state", async () => {
		const { presence, sent, move, settle, hold } = await room();
		presence.joined(7);
		await settle(0);
		const release = hold();

		for (let head = 1; head <= 5; head++) {
			move(head);
			await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
		}
		release();
		await settle(ANNOUNCE_MS);

		expect(sent()).toBe(2);
		presence.dispose();
	});

	it("counts anyone whose frame arrives, readable or not, until they leave", async () => {
		const { presence, sent, move, settle } = await room();

		await presence.receive(new Uint8Array(40), 9);
		move(1);
		await settle(0);
		expect(sent()).toBe(1);

		presence.depart(9);
		await settle(ANNOUNCE_MS);
		move(2);
		await settle(ANNOUNCE_MS);
		expect(sent()).toBe(1);
		presence.dispose();
	});

	it("keeps a change for the next one met when the last leaves before it goes", async () => {
		const { presence, sent, move, settle } = await room();
		presence.joined(7);
		await settle(0);

		move(1);
		presence.depart(7);
		await settle(ANNOUNCE_MS);
		expect(sent()).toBe(1);

		await presence.receive(new Uint8Array(40), 9);
		await settle(0);
		expect(sent()).toBe(2);
		presence.dispose();
	});

	it("tells the first one it meets what changed while it was alone", async () => {
		const { presence, sent, move, settle } = await room();
		await presence.receive(new Uint8Array(40), 9);
		await settle(0);
		expect(sent()).toBe(0);
		presence.depart(9);

		move(1);
		await presence.receive(new Uint8Array(40), 10);
		await settle(0);

		expect(sent()).toBe(1);
		presence.dispose();
	});

	it("goes quiet when its own socket drops", async () => {
		const { presence, sent, move, settle } = await room();
		presence.joined(7);
		await settle(ANNOUNCE_MS);

		presence.dropAll();
		move(1);
		await settle(ANNOUNCE_MS);

		expect(sent()).toBe(1);
		presence.dispose();
	});
});
