import { describe, expect, it } from "vitest";
import type { RelayStatus } from "@/core/hub";
import type { RelaySocket } from "@/features/relay";
import type { StatusHost } from "@/features/status/host";
import { relayGroups, sharesConnected } from "@/features/status/live-spaces";

const HOME = "https://relay.home.example";
const OTHER = "https://relay.friend.example";

function host(
	sockets: RelaySocket[],
	statuses: Record<string, RelayStatus>,
	ids = Object.keys(statuses),
): StatusHost {
	return {
		settings: { relayUrl: `${HOME}/`, relaySecret: "secret" },
		spaces: { partition: () => ids.map((id) => ({ id, root: id })) },
		realtime: {
			hub: {
				relays: () => sockets,
				statusOf: (id: string) => statuses[id] ?? "off",
			},
		},
	} as unknown as StatusHost;
}

describe("relayGroups", () => {
	it("puts each carried space under the socket that carries it", () => {
		const groups = relayGroups(
			host(
				[
					{
						url: HOME,
						state: "connected",
						spaces: ["vault", "a", "b"],
						full: ["c"],
					},
					{ url: OTHER, state: "offline", spaces: ["d"], full: [] },
				],
				{
					vault: "connected",
					a: "connected",
					b: "unauthorized",
					c: "full",
					d: "offline",
				},
			),
		);

		expect(groups).toEqual([
			{
				name: "Your relay",
				state: "connected",
				spaces: [
					{ id: "vault", status: "connected" },
					{ id: "a", status: "connected" },
					{ id: "b", status: "unauthorized" },
				],
				full: ["c"],
			},
			{
				name: "relay.friend.example",
				state: "offline",
				spaces: [{ id: "d", status: "offline" }],
				full: [],
			},
		]);
	});

	it("leaves out spaces this device does not mount, and a relay left with none", () => {
		const groups = relayGroups(
			host(
				[
					{
						url: HOME,
						state: "connecting",
						spaces: ["vault", "gone"],
						full: ["late"],
					},
					{ url: OTHER, state: "connected", spaces: ["gone"], full: [] },
				],
				{ vault: "connecting", gone: "connected", late: "full" },
				["vault"],
			),
		);

		expect(groups).toEqual([
			{
				name: "Your relay",
				state: "connecting",
				spaces: [{ id: "vault", status: "connecting" }],
				full: [],
			},
		]);
	});
});

describe("sharesConnected", () => {
	it("is true only for a connected shared folder", () => {
		expect(sharesConnected([{ id: "a", status: "connected" }])).toBe(true);
	});

	it.each(["offline", "connecting", "unauthorized"] as const)(
		"is false while the only shared folder is %s",
		(status) => {
			expect(
				sharesConnected([
					{ id: "vault", status: "connected" },
					{ id: "a", status },
				]),
			).toBe(false);
		},
	);

	it("is false for the vault alone", () => {
		expect(sharesConnected([{ id: "vault", status: "connected" }])).toBe(false);
	});
});
