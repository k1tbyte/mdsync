import {
	deriveChannelGrant,
	EFrame,
	grantExpiry,
	MAX_SLOTS,
	type ServerFrame,
	shareChannel,
} from "@mdsync/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hubRoutes } from "@/hub/channels";
import { HubConnection } from "@/hub/connection";
import type { HubLinkOptions } from "@/hub/link";
import type { LinkState } from "@/hub/status";
import { DEFAULT_SETTINGS, type MdsyncSettings } from "@/settings/model";
import type { SpaceRecord } from "@/spaces/record";

const { links, FakeLink } = vi.hoisted(() => {
	const links: InstanceType<typeof FakeLink>[] = [];
	class FakeLink {
		readonly connect = vi.fn();
		readonly dispose = vi.fn();
		readonly send = vi.fn();
		readonly signal = vi.fn();
		state: LinkState = "connecting";
		constructor(readonly options: HubLinkOptions) {
			links.push(this);
		}
	}
	return { links, FakeLink };
});

vi.mock("@/hub/link", () => ({ HubLink: FakeLink }));

const HOME = "https://home.example";
const OTHER = "https://other.example";

function owned(id: string): SpaceRecord {
	return {
		id,
		name: id,
		root: id,
		rev: 1,
		author: "laptop",
		key: "",
		access: {
			kind: "owner",
			location: {
				endpoint: "https://s3.example",
				region: "auto",
				bucket: "notes",
				prefix: "vault",
				forcePathStyle: true,
			},
		},
	};
}

function joined(id: string, relayUrl: string): SpaceRecord {
	return {
		...owned(id),
		access: {
			kind: "participant",
			relayUrl,
			token: `token-${id}`,
			participantId: "p1",
			personName: "Friend",
		},
	};
}

function settingsWith(spaces: SpaceRecord[]): MdsyncSettings {
	return {
		...DEFAULT_SETTINGS,
		realtimeSync: true,
		relayUrl: HOME,
		relaySecret: "secret",
		activeStorageKind: "s3",
		storageConfigs: {
			s3: {
				kind: "s3",
				endpoint: "https://s3.example",
				region: "auto",
				bucket: "notes",
				prefix: "vault",
				accessKeyId: "id",
				secretAccessKey: "key",
				forcePathStyle: true,
				concurrency: 4,
			},
		},
		spaces,
	} as MdsyncSettings;
}

describe("hubRoutes", () => {
	it("puts the vault and its owned shares on the home relay, joined shares on their owner's", async () => {
		const routes = hubRoutes(
			settingsWith([
				owned("mine"),
				joined("theirs", `${OTHER}/`),
				joined("near", HOME),
			]),
		);

		expect(routes.map(({ serverUrl, spaces }) => [serverUrl, spaces])).toEqual([
			[HOME, ["vault", "mine", "near"]],
			[OTHER, ["theirs"]],
		]);
		const [home, other] = await Promise.all(
			routes.map((route) => route.channels()),
		);
		const mine = home?.[1];
		expect(mine?.channel).toBe(shareChannel("mine"));
		expect(mine?.token).toBe(
			await deriveChannelGrant(
				"secret",
				shareChannel("mine"),
				grantExpiry(mine?.token ?? "") ?? 0,
			),
		);
		expect(home?.[2]).toEqual({
			channel: shareChannel("near"),
			token: "token-near",
		});
		expect(other).toEqual([
			{ channel: shareChannel("theirs"), token: "token-theirs" },
		]);
	});

	it("names the shares past a relay's slots instead of carrying them", () => {
		const shares = Array.from({ length: MAX_SLOTS + 1 }, (_, i) =>
			owned(`s${i}`),
		);
		const [home] = hubRoutes(settingsWith(shares));

		expect(home?.spaces).toHaveLength(MAX_SLOTS);
		expect(home?.full).toEqual([`s${MAX_SLOTS - 1}`, `s${MAX_SLOTS}`]);
	});

	it("keeps joined shares without a relay of this device's own, and nothing with realtime off", () => {
		const settings = settingsWith([owned("mine"), joined("theirs", OTHER)]);

		expect(
			hubRoutes({ ...settings, relayUrl: "" }).map((route) => route.spaces),
		).toEqual([["theirs"]]);
		expect(hubRoutes({ ...settings, realtimeSync: false })).toEqual([]);
	});

	it("drops closed shares and those paused here", () => {
		const closed = { ...joined("theirs", OTHER), closed: true as const };
		const routes = hubRoutes({
			...settingsWith([
				{ ...owned("mine"), closed: true },
				closed,
				owned("resting"),
				joined("away", OTHER),
				{ ...owned("everywhere"), paused: true },
			]),
			pausedSpaces: ["resting", "away"],
		});

		expect(routes.map((route) => route.spaces)).toEqual([["vault"]]);
	});

	it("carries only the vault where shared folders are off", () => {
		const routes = hubRoutes({
			...settingsWith([owned("mine"), joined("theirs", OTHER)]),
			useSharedFolders: false,
		});

		expect(routes.map((route) => route.spaces)).toEqual([["vault"]]);
	});
});

describe("HubConnection", () => {
	let settings: MdsyncSettings;
	const connection = () =>
		new HubConnection({ settings: () => settings, deviceId: () => "laptop" });

	beforeEach(() => {
		links.length = 0;
		settings = settingsWith([owned("mine")]);
	});

	it("reconnects only the socket whose channels changed", () => {
		const hub = connection();
		const onConnectionChange = vi.fn();
		hub.listen({ onConnectionChange });
		hub.restart();
		const [home] = links;

		settings = settingsWith([owned("mine"), joined("theirs", OTHER)]);
		hub.restartIfChanged();
		expect(home?.dispose).not.toHaveBeenCalled();
		expect(links.map((link) => link.options.serverUrl)).toEqual([HOME, OTHER]);
		expect(onConnectionChange).not.toHaveBeenCalled();

		settings = settingsWith([joined("theirs", OTHER)]);
		hub.restartIfChanged();
		expect(home?.dispose).toHaveBeenCalledOnce();
		expect(links[1]?.dispose).not.toHaveBeenCalled();
		expect(onConnectionChange.mock.calls).toEqual([[false]]);
	});

	it("reconnects only the socket carrying the space", () => {
		settings = settingsWith([owned("mine"), joined("theirs", OTHER)]);
		const hub = connection();
		hub.restart();
		const [home, other] = links;

		hub.reconnect("theirs");

		expect(home?.dispose).not.toHaveBeenCalled();
		expect(other?.dispose).toHaveBeenCalledOnce();
		expect(links.map((link) => link.options.serverUrl)).toEqual([
			HOME,
			OTHER,
			OTHER,
		]);
		expect(links[2]?.connect).toHaveBeenCalledOnce();
	});

	it("signals a space on its own socket and slot", () => {
		settings = settingsWith([owned("mine"), joined("theirs", OTHER)]);
		const hub = connection();
		hub.restart();
		const [home, other] = links;

		hub.signal("mine");
		hub.signal("theirs");

		expect(home?.signal.mock.calls).toEqual([[1]]);
		expect(other?.signal.mock.calls).toEqual([[0]]);
	});

	it("hands each space its own frames and every socket's signals to all", () => {
		settings = settingsWith([owned("mine"), joined("theirs", OTHER)]);
		const hub = connection();
		const vault = vi.fn();
		const theirs = vi.fn();
		const onSignal = vi.fn();
		hub.space("vault").listen({ onFrame: vault });
		hub.space("theirs").listen({ onFrame: theirs });
		hub.listen({ onSignal });
		hub.restart();
		const [home, other] = links;
		const peer = (slot: number): ServerFrame => ({
			type: EFrame.Peer,
			slot,
			doc: "",
			from: 7,
			payload: Uint8Array.of(1),
		});

		home?.options.onFrame(peer(1));
		other?.options.onFrame(peer(0));
		home?.options.onFrame(peer(0));
		home?.options.onFrame({ type: EFrame.Signal, slot: 1, doc: "", from: 7 });

		expect(vault.mock.calls).toEqual([[peer(0)]]);
		expect(theirs.mock.calls).toEqual([[peer(0)]]);
		expect(onSignal.mock.calls).toEqual([["mine"]]);
		home?.options.onFrame({ type: EFrame.Signal, slot: 0, doc: "", from: 7 });
		other?.options.onFrame({ type: EFrame.Signal, slot: 0, doc: "", from: 7 });
		home?.options.onFrame({ type: EFrame.Signal, slot: 99, doc: "", from: 7 });
		expect(onSignal.mock.calls).toEqual([["mine"], ["vault"], ["theirs"]]);
	});

	it("sends a space's frames on its socket at its slot", () => {
		settings = settingsWith([owned("mine"), joined("theirs", OTHER)]);
		const hub = connection();
		hub.restart();
		const [home, other] = links;

		hub.space("mine").send({ type: EFrame.Unsub, doc: "d" });
		hub.space("theirs").send({ type: EFrame.Unsub, doc: "d" });

		expect(home?.send.mock.calls).toEqual([
			[{ type: EFrame.Unsub, slot: 1, doc: "d" }],
		]);
		expect(other?.send.mock.calls).toEqual([
			[{ type: EFrame.Unsub, slot: 0, doc: "d" }],
		]);
	});

	it("reports each space connected with its socket, and a revoked one down", () => {
		settings = settingsWith([owned("mine"), joined("theirs", OTHER)]);
		const hub = connection();
		const changes: [string, boolean][] = [];
		for (const id of ["vault", "mine", "theirs"]) {
			hub.space(id).listen({
				onConnectionChange: (connected) => changes.push([id, connected]),
			});
		}
		const onRevoked = vi.fn();
		hub.listen({ onRevoked });
		hub.restart();
		const [home] = links;

		if (home) home.state = "connected";
		home?.options.onConnectionChange?.(true);
		expect(changes).toEqual([
			["vault", true],
			["mine", true],
		]);
		expect(hub.space("theirs").isConnected()).toBe(false);

		home?.options.onFrame({ type: EFrame.Revoked, slot: 1, doc: "" });
		expect(changes.at(-1)).toEqual(["mine", false]);
		expect(onRevoked).toHaveBeenCalledOnce();
		expect(hub.space("mine").isConnected()).toBe(false);
		expect(hub.isConnected()).toBe(true);
	});

	it("tells why a space has no live channel, or how its socket stands", () => {
		settings = {
			...settingsWith([
				owned("mine"),
				joined("theirs", OTHER),
				owned("resting"),
			]),
			pausedSpaces: ["resting"],
		};
		const hub = connection();
		expect(hub.statusOf("vault")).toBe("no-relay");

		hub.restart();
		const [home, other] = links;
		expect(hub.statusOf("vault")).toBe("connecting");
		expect(hub.statusOf("elsewhere")).toBe("no-relay");
		expect(hub.statusOf("resting")).toBe("paused");

		if (home) home.state = "connected";
		if (other) other.state = "unauthorized";
		expect(hub.statusOf("mine")).toBe("connected");
		expect(hub.statusOf("theirs")).toBe("unauthorized");

		home?.options.onFrame({ type: EFrame.Revoked, slot: 1, doc: "" });
		expect(hub.statusOf("mine")).toBe("unauthorized");
		expect(hub.statusOf("vault")).toBe("connected");

		// The vault has no record: shares off here leave its relay alone.
		settings = { ...settings, useSharedFolders: false };
		expect(hub.statusOf("theirs")).toBe("paused");
		expect(hub.statusOf("vault")).toBe("connected");

		settings = { ...settings, realtimeSync: false };
		expect(hub.statusOf("vault")).toBe("off");
	});

	it("says a share past the relay's slots is full, not unconfigured", () => {
		settings = settingsWith(
			Array.from({ length: MAX_SLOTS }, (_, i) => owned(`s${i}`)),
		);
		const hub = connection();
		hub.restart();
		expect(hub.statusOf(`s${MAX_SLOTS - 2}`)).toBe("connecting");
		expect(hub.statusOf(`s${MAX_SLOTS - 1}`)).toBe("full");

		// Past the slots nothing reconnects, yet the status follows.
		settings = { ...settings, spaces: [...settings.spaces, owned("late")] };
		hub.restartIfChanged();
		expect(links).toHaveLength(1);
		expect(hub.statusOf("late")).toBe("full");
	});

	it("asks again for a slot the relay refused while its socket stays up, a few times", () => {
		vi.useFakeTimers();
		settings = settingsWith([owned("mine")]);
		const hub = connection();
		hub.restart();
		const revoke = () =>
			links.at(-1)?.options.onFrame({ type: EFrame.Revoked, slot: 1, doc: "" });

		for (let attempt = 0; attempt < 3; attempt++) {
			revoke();
			vi.advanceTimersByTime(200_000);
			expect(links).toHaveLength(2 + attempt);
		}
		revoke();
		vi.advanceTimersByTime(400_000);

		expect(links).toHaveLength(4);
		vi.useRealTimers();
	});

	it("starts counting afresh once the space is heard from", () => {
		vi.useFakeTimers();
		settings = settingsWith([owned("mine")]);
		const hub = connection();
		hub.restart();
		const last = () => links.at(-1)?.options;

		for (let cycle = 0; cycle < 4; cycle++) {
			last()?.onFrame({ type: EFrame.Revoked, slot: 1, doc: "" });
			vi.advanceTimersByTime(200_000);
			last()?.onFrame({ type: EFrame.Leave, slot: 1, doc: "", from: 2 });
		}

		expect(links).toHaveLength(5);
		vi.useRealTimers();
		hub.dispose();
	});
});
