import { EFrame } from "@mdsync/protocol";
import {
	converge,
	FLUSHED_MS,
	sentUpdate,
	sleep,
	textOf,
	type,
	useLiveRoom,
	waitUntil,
	windClockUntil,
} from "@tests/helpers/live-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import * as sealing from "@/crypto/seal";

const live = useLiveRoom();
const { synced } = live;

afterEach(() => vi.useRealTimers());

describe("live session across sockets", () => {
	it("replays 199 catch-up deltas with one observer transaction", async () => {
		const a = await synced("x");
		a.connection.disconnect();
		await live.typedElsewhere(199);
		const observe = vi.fn();
		a.session.model.text.observe(observe);
		a.connection.connect();
		await waitUntil(() => expect(a.session.seq).toBe(200));
		expect(textOf(a)).toHaveLength(200);
		expect(textOf(a).replace("x", "")).toBe("z".repeat(199));
		expect(observe).toHaveBeenCalledOnce();
		expect(a.agreed).toEqual({ text: textOf(a), seq: 200 });
	});

	it("discards a state decrypted after its socket epoch changed", async () => {
		const a = await synced("x");
		const state = await live.roomState();
		if (state.type !== EFrame.State) throw new Error("Expected room state");
		const doc = new Y.Doc();
		doc.getText("body").insert(0, "stale");
		const payload = await sealing.seal(
			live.keys,
			Y.encodeStateAsUpdate(doc),
			`doc:${live.docId}`,
		);
		doc.destroy();
		let release!: () => void;
		let started!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const unseal = sealing.unseal;
		vi.spyOn(sealing, "unseal").mockImplementationOnce(async (...args) => {
			started();
			await blocked;
			return unseal(...args);
		});
		a.session.onFrame({
			...state,
			head: state.head + 1,
			snapshot: null,
			deltas: [payload],
		});
		await entered;
		a.connection.disconnect();
		release();
		a.connection.connect();
		await sleep(20);
		expect(textOf(a)).toBe("x");
		expect(a.session.seq).toBe(1);
		expect(a.session.movedTo).toBeNull();
		expect(a.refused).toBeNull();
	});

	it("resends an update the wire lost once the socket comes back", async () => {
		const a = await synced("x");
		const b = await synced("x");
		a.connection.dropOutgoing();
		const updateSent = sentUpdate(a);

		type(a, 1, "y");
		await updateSent();
		await sleep(FLUSHED_MS);
		expect(textOf(b)).toBe("x");

		a.connection.disconnect();
		a.connection.connect();
		await converge("xy", a, b);
	});

	it("stays in step after an echo died with its socket", async () => {
		const a = await synced("x");
		const b = await synced("x");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		a.connection.dropIncoming();

		type(a, 1, "y");
		await windClockUntil(() => expect(textOf(b)).toBe("xy"));
		a.connection.disconnect();
		a.connection.connect();
		type(a, 2, "z");

		await windClockUntil(() => {
			expect([textOf(a), textOf(b)]).toEqual(["xyz", "xyz"]);
			expect(a.session.settled).toBe(true);
		});
		await vi.advanceTimersByTimeAsync(FLUSHED_MS);
		expect([textOf(a), textOf(b)]).toEqual(["xyz", "xyz"]);
	});

	it("never agrees on an edit the room has not got", async () => {
		const a = await synced("x");
		await waitUntil(() => expect(a.agreed).toEqual({ text: "x", seq: 1 }));
		a.connection.dropOutgoing();
		const updateSent = sentUpdate(a);

		type(a, 1, "y");
		await updateSent();
		await sleep(FLUSHED_MS);

		expect(a.agreed).toEqual({ text: "x", seq: 1 });
	});
});

describe("live session past the hub's rate", () => {
	it("resends an update the hub dropped once a later echo shows the gap", async () => {
		const a = await synced("x");
		const b = await synced("x");
		a.connection.dropUpdates(1);
		const updateSent = sentUpdate(a);

		type(a, 1, "y");
		await updateSent();
		await sleep(FLUSHED_MS);
		type(a, 2, "z");

		await converge("xyz", a, b);
		await waitUntil(() => expect(a.session.settled).toBe(true));
	});

	it("resends a dropped last update once no echo came for it", async () => {
		const a = await synced("x");
		const b = await synced("x");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		a.connection.dropUpdates(1);

		type(a, 1, "y");

		await windClockUntil(() => {
			expect(textOf(b)).toBe("xy");
			expect(a.session.settled).toBe(true);
		});
	});
});

describe("live session closed with an edit in flight", () => {
	it("sends the last edit once, not again on every ack patience", async () => {
		const a = await synced("x");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const send = vi.spyOn(a.connection, "send");
		const updates = () =>
			send.mock.calls.filter(([frame]) => frame.type === EFrame.Update).length;

		type(a, 1, "y");
		a.session.dispose();
		await windClockUntil(() => expect(updates()).toBe(1));
		await vi.advanceTimersByTimeAsync(60_000);

		expect(updates()).toBe(1);
	});
});
