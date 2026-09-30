export interface Person {
	/** Groups and colours: the person in a share, the device in the vault. */
	key: string;
	name: string;
	/** The vault path of their open file; null while it is elsewhere. */
	note: string | null;
	idle: boolean;
}

export function onePerPerson(people: readonly Person[]): Person[] {
	const byKey = new Map<string, Person>();
	for (const person of people) {
		const known = byKey.get(person.key);
		if (!known || presenceRank(person) > presenceRank(known)) {
			byKey.set(person.key, person);
		}
	}
	return sortByName([...byKey.values()]);
}

export function byNote(
	groups: Iterable<readonly Person[]>,
): Map<string, Person[]> {
	const byPath = new Map<string, Map<string, Person>>();
	for (const people of groups) {
		for (const person of people) {
			if (person.note === null) continue;
			const here = byPath.get(person.note) ?? new Map<string, Person>();
			const known = here.get(person.key);
			here.set(person.key, {
				...person,
				idle: person.idle && (known?.idle ?? true),
			});
			byPath.set(person.note, here);
		}
	}
	return new Map(
		[...byPath].map(([note, here]) => [note, sortByName([...here.values()])]),
	);
}

function presenceRank(person: Person): number {
	return (person.idle ? 0 : 2) + (person.note === null ? 0 : 1);
}

function sortByName(people: Person[]): Person[] {
	return people.sort(
		(left, right) =>
			left.name.localeCompare(right.name) || left.key.localeCompare(right.key),
	);
}
