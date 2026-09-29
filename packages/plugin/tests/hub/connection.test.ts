import {
	deriveChannelGrant,
	EFrame,
	type ServerFrame,
	shareChannel,
} from "@obsync/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hubRoutes } from "@/hub/channels";
import { HubConnection } from "@/hub/connection";
import type { HubLinkOptions } from "@/hub/link";
import type { LinkState } from "@/hub/status";
import { DEFAULT_SETTINGS, type ObsyncSettings } from "@/settings/model";
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

function settingsWith(spaces: SpaceRecord[]): ObsyncSettings {
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
	} as ObsyncSettings;
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
		expect(home?.[1]).toEqual({
			channel: shareChannel("mine"),
			token: await deriveChannelGrant("secret", shareChannel("mine")),
		});
		expect(home?.[2]).toEqual({
			channel: shareChannel("near"),
			token: "token-near",
		});
		expect(other).toEqual([
			{ channel: shareChannel("theirs"), token: "token-theirs" },
		]);
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
			]),
			pausedSpaces: ["resting", "away"],
		});

		expect(routes.map((route) => route.spaces)).toEqual([["vault"]]);
	});
});

describe("HubConnection", () => {
	let settings: ObsyncSettings;
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
		expect(onSignal).toHaveBeenCalledOnce();
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
		expect(hub.space("mine").isConnected()).toBe(false);
		expect(hub.isConnected()).toBe(true);
	});

	it("tells why a space has no live channel, or how its socket stands", () => {
		settings = {
			...settingsWith([owned("mine"), joined("theirs", OTHER)]),
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

		settings = { ...settings, realtimeSync: false };
		expect(hub.statusOf("vault")).toBe("off");
	});
});
