import { vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import type { SpaceRecord } from "@/spaces/record";

const LOCATION = {
	endpoint: "https://s3.example",
	region: "auto",
	bucket: "notes",
	prefix: "vault",
	forcePathStyle: true,
};

export const owned = (relayUrl?: string): SpaceRecord => ({
	id: "s1",
	name: "Team",
	root: "Team",
	rev: 1,
	author: "laptop",
	key: "",
	access: {
		kind: "owner",
		location: LOCATION,
		...(relayUrl ? { relayUrl } : {}),
	},
});

export const joined = (readOnly = false): SpaceRecord => ({
	...owned(),
	access: {
		kind: "participant",
		relayUrl: "https://relay.example",
		token: "t",
		participantId: "p",
		personName: "Me",
		...(readOnly ? { readOnly: true as const } : {}),
	},
});

export function host(relay = true) {
	const openFile = vi.fn();
	const plugin = {
		app: {
			vault: { getFileByPath: (path: string) => ({ path }) },
			workspace: { getLeaf: () => ({ openFile }) },
		},
		settings: {
			relayUrl: relay ? "https://relay.example" : "",
			relaySecret: relay ? "secret" : "",
		},
		realtime: {
			people: {
				online: () => [],
				unreadable: () => false,
				subscribe: () => () => {},
			},
			statusOf: () => "connected",
		},
		spaces: {
			partition: () => [{ id: "s1", paused: false }],
			setPaused: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		controller: {
			refresh: vi.fn(async () => {}),
			currentDevice: () => ({ id: "laptop" }),
			forgetSpace: vi.fn(async () => {}),
		},
	} as unknown as PluginHost;
	return { plugin, openFile };
}
