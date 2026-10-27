import type { PluginHost } from "@/app/host";
import { DEFAULT_SETTINGS } from "@/core/settings/model";
import type { LinkRecord } from "@/features/links/record";
import { SharedLinks } from "@/features/links/shared-links";
import type { Person } from "@/features/presence/people";
import { Unseen } from "@/features/presence/unseen";
import type { Space } from "@/features/sync/remote/space";

export const ALEX: Person = {
	key: "p1",
	name: "Alex",
	devices: [],
	note: "Team/docs/a.md",
	idle: false,
};
export const SAM: Person = {
	key: "p2",
	name: "Sam",
	devices: [],
	note: "Team/b.md",
	idle: true,
};
export const LAPTOP: Person = {
	key: "d1",
	name: "Laptop",
	devices: [],
	note: "notes/x.md",
	idle: false,
};

export const LINK: LinkRecord = {
	id: "link",
	url: "https://example.com/link",
	rev: 0,
	author: "",
	path: "notes/published.md",
	showTitle: true,
	detached: false,
	createdAt: 0,
	publishedAt: 0,
	expires: null,
	maxViews: null,
	salt: null,
	images: false,
};

const RECORDS = [
	{ id: "own", access: { kind: "owner" } },
	{ id: "in", access: { kind: "participant", readOnly: false } },
];

export function host(
	spaces: Space[],
	people: Person[],
	unseen: string[] = [],
	links: LinkRecord[] = [],
): PluginHost {
	const settings = { ...DEFAULT_SETTINGS, links };
	return {
		settings,
		sharedLinks: new SharedLinks({
			settings: () => settings,
			save: async () => {},
			author: () => "laptop",
			announce: () => {},
		}),
		app: {
			vault: {
				getFileByPath: (path: string) => ({ path, stat: { mtime: 0 } }),
			},
		},
		controller: {
			lastEdit: () => ({ key: "p1", name: "Alex", at: Date.now() }),
		},
		ignoreState: { ignoredPaths: () => [], subscribe: () => () => {} },
		unseen: new Unseen({ load: () => unseen, save: () => {} }),
		spaces: {
			partition: () => spaces,
			get: (id: string) => RECORDS.find((record) => record.id === id),
		},
		realtime: {
			people: {
				subscribe: () => () => {},
				online: (id: string) =>
					id === "own" ? people.filter((p) => p.note?.startsWith("Team/")) : [],
				notes: () => {
					const notes = new Map<string, Person[]>();
					for (const person of people) {
						if (person.note) notes.set(person.note, [person]);
					}
					return notes;
				},
			},
		},
	} as unknown as PluginHost;
}
