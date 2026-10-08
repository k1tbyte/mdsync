import { type LinkRecord, SharedLinks } from "@/links";
import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { Unseen } from "@/presence/unseen";
import { DEFAULT_SETTINGS } from "@/settings/model";
import type { Space } from "@/sync/space";

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
	path: "notes/published.md",
	title: "Published",
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
		sharedLinks: new SharedLinks(
			() => settings,
			async () => {},
		),
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
