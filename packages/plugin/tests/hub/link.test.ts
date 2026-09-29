import { UNAUTHORIZED_CLOSE_CODE } from "@obsync/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HubLink } from "@/hub/link";

class FakeSocket extends EventTarget {
	static readonly OPEN = 1;
	static opened: FakeSocket[] = [];
	readyState = FakeSocket.OPEN;
	binaryType = "";

	constructor(readonly url: string) {
		super();
		FakeSocket.opened.push(this);
	}

	send(): void {}
	close(): void {}

	emit(type: string, fields: object = {}): void {
		this.dispatchEvent(Object.assign(new Event(type), fields));
	}
}

let link: HubLink;
let windowEvents: EventTarget & typeof globalThis;
let documentEvents: EventTarget & { visibilityState: string };

function last(): FakeSocket {
	return FakeSocket.opened[FakeSocket.opened.length - 1] as FakeSocket;
}

beforeEach(async () => {
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.spyOn(Math, "random").mockReturnValue(1);
	windowEvents = Object.assign(new EventTarget(), {
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
	}) as typeof windowEvents;
	documentEvents = Object.assign(new EventTarget(), {
		visibilityState: "visible",
	});
	vi.stubGlobal("window", windowEvents);
	vi.stubGlobal("document", documentEvents);
	vi.spyOn(windowEvents, "addEventListener");
	FakeSocket.opened = [];
	link = new HubLink({
		serverUrl: "https://relay.test",
		channels: Promise.resolve([{ channel: "c", token: "t" }]),
		deviceId: "d",
		onFrame: () => {},
	});
	link.connect();
	await vi.advanceTimersByTimeAsync(0);
});

afterEach(() => {
	link.dispose();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("hub link reconnects", () => {
	it("retries a refused socket a few times, then stops", async () => {
		for (let refusals = 1; refusals <= 6; refusals++) {
			last().emit("close", { code: UNAUTHORIZED_CLOSE_CODE });
			await vi.advanceTimersByTimeAsync(60_000);
			expect(FakeSocket.opened).toHaveLength(refusals + 1);
		}

		last().emit("close", { code: UNAUTHORIZED_CLOSE_CODE });
		await vi.advanceTimersByTimeAsync(600_000);
		expect(FakeSocket.opened).toHaveLength(7);
	});

	it("backs off while sockets drop unanswered, and starts over after an answer", async () => {
		last().emit("close", { code: 1006 });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(FakeSocket.opened).toHaveLength(2);

		last().emit("open");
		last().emit("close", { code: 1006 });
		await vi.advanceTimersByTimeAsync(3_999);
		expect(FakeSocket.opened).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeSocket.opened).toHaveLength(3);

		last().emit("message", { data: "pong" });
		last().emit("close", { code: 1006 });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(FakeSocket.opened).toHaveLength(4);
	});
});

describe("hub link state", () => {
	it("says why it is down: connecting, connected, offline, then unauthorized once refusals run out", async () => {
		expect(link.state).toBe("connecting");
		last().emit("open");
		expect(link.state).toBe("connected");

		last().emit("close", { code: 1006 });
		expect(link.state).toBe("offline");

		for (let refusals = 1; refusals <= 6; refusals++) {
			await vi.advanceTimersByTimeAsync(60_000);
			last().emit("close", { code: UNAUTHORIZED_CLOSE_CODE });
			expect(link.state).toBe("offline");
		}
		await vi.advanceTimersByTimeAsync(60_000);
		last().emit("close", { code: UNAUTHORIZED_CLOSE_CODE });
		expect(link.state).toBe("unauthorized");
	});

	it("reports every change of state through onConnectionChange", async () => {
		const changes: boolean[] = [];
		link.dispose();
		link = new HubLink({
			serverUrl: "https://relay.test",
			channels: Promise.resolve([{ channel: "c", token: "t" }]),
			deviceId: "d",
			onFrame: () => {},
			onConnectionChange: (connected) => changes.push(connected),
		});
		link.connect();
		await vi.advanceTimersByTimeAsync(0);

		last().emit("open");
		last().emit("close", { code: 1006 });

		expect(changes).toEqual([true, false]);
	});
});

describe("hub link wakes", () => {
	it("retries at once when the network returns, whatever the backoff", async () => {
		last().emit("close", { code: 1006 });
		const before = FakeSocket.opened.length;

		windowEvents.dispatchEvent(new Event("online"));
		await vi.advanceTimersByTimeAsync(0);
		expect(FakeSocket.opened).toHaveLength(before + 1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(FakeSocket.opened).toHaveLength(before + 1);
	});

	it("retries when the page turns visible, not when it hides", async () => {
		last().emit("close", { code: 1006 });
		const before = FakeSocket.opened.length;

		documentEvents.visibilityState = "hidden";
		documentEvents.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(FakeSocket.opened).toHaveLength(before);

		documentEvents.visibilityState = "visible";
		documentEvents.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(FakeSocket.opened).toHaveLength(before + 1);
	});

	it("leaves a connected link alone", async () => {
		last().emit("open");
		const before = FakeSocket.opened.length;

		windowEvents.dispatchEvent(new Event("online"));
		documentEvents.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);

		expect(FakeSocket.opened).toHaveLength(before);
	});

	it("tries a refused link again, and stays refused while the relay says so", async () => {
		for (let refusals = 1; refusals <= 7; refusals++) {
			last().emit("close", { code: UNAUTHORIZED_CLOSE_CODE });
			await vi.advanceTimersByTimeAsync(60_000);
		}
		expect(link.state).toBe("unauthorized");
		const before = FakeSocket.opened.length;

		windowEvents.dispatchEvent(new Event("online"));
		await vi.advanceTimersByTimeAsync(0);
		last().emit("close", { code: UNAUTHORIZED_CLOSE_CODE });
		await vi.advanceTimersByTimeAsync(600_000);

		expect(FakeSocket.opened).toHaveLength(before + 1);
		expect(link.state).toBe("unauthorized");
	});

	it("registers its listeners once and removes them on dispose", () => {
		const registered = () =>
			vi
				.mocked(windowEvents.addEventListener)
				.mock.calls.filter(([type]) => type === "online");
		expect(registered()).toHaveLength(1);
		link.connect();
		expect(registered()).toHaveLength(1);

		const [, , options] = registered()[0] as [
			string,
			unknown,
			{ signal: AbortSignal },
		];
		expect(options.signal.aborted).toBe(false);
		link.dispose();
		expect(options.signal.aborted).toBe(true);
	});
});

describe("hub link backoff jitter", () => {
	it("waits between half and all of the backoff", async () => {
		vi.mocked(Math.random).mockReturnValue(0);
		last().emit("close", { code: 1006 });
		await vi.advanceTimersByTimeAsync(999);
		expect(FakeSocket.opened).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeSocket.opened).toHaveLength(2);

		vi.mocked(Math.random).mockReturnValue(0.5);
		last().emit("close", { code: 1006 });
		await vi.advanceTimersByTimeAsync(2_999);
		expect(FakeSocket.opened).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeSocket.opened).toHaveLength(3);
	});
});
