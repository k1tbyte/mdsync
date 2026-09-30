import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { Unseen } from "@/presence/unseen";
import type { Space } from "@/sync/space";

export const ALEX: Person = {
	key: "p1",
	name: "Alex",
	note: "Team/docs/a.md",
	idle: false,
};
export const SAM: Person = {
	key: "p2",
	name: "Sam",
	note: "Team/b.md",
	idle: true,
};
export const LAPTOP: Person = {
	key: "d1",
	name: "Laptop",
	note: "notes/x.md",
	idle: false,
};

const RECORDS = [
	{ id: "own", access: { kind: "owner" } },
	{ id: "in", access: { kind: "participant", readOnly: false } },
];

export function host(
	spaces: Space[],
	people: Person[],
	unseen: string[] = [],
): PluginHost {
	return {
		app: { vault: { getFileByPath: (path: string) => ({ path }) } },
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
