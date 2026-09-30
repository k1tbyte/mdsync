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

const live = useLiveRoom();
const { synced } = live;

afterEach(() => vi.useRealTimers());

describe("live session across sockets", () => {
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
