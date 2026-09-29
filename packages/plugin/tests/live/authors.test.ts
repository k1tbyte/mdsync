import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { authorOf, authorRanges, USERS } from "@/live/authors";
import { BODY } from "@/live/text/rebuild";

const OWNER = { person: "owner", name: "Owner" };
const FRIEND = { person: "p1", name: "Friend" };

/** "owner " typed by client 1, "friend " by 2, "again" by 1 on another session (3), all named. */
function shared(): Y.Doc {
	const doc = new Y.Doc();
	const type = (client: number, at: number, text: string) => {
		doc.clientID = client;
		doc.getText(BODY).insert(at, text);
	};
	type(1, 0, "owner ");
	type(2, 6, "friend ");
	type(3, 13, "again");
	const users = doc.getMap(USERS);
	users.set("1", OWNER);
	users.set("2", FRIEND);
	users.set("3", OWNER);
	return doc;
}

describe("authors", () => {
	it("tints only what others typed, clipped to the visible ranges", () => {
		const doc = shared();
		const text = doc.getText(BODY);
		const users = doc.getMap(USERS);

		expect(authorRanges(text, users, [{ from: 0, to: 18 }], "p1")).toEqual([
			{ from: 0, to: 6, author: OWNER },
			{ from: 13, to: 18, author: OWNER },
		]);
		expect(
			authorRanges(
				text,
				users,
				[
					{ from: 2, to: 8 },
					{ from: 10, to: 11 },
				],
				"owner",
			),
		).toEqual([
			{ from: 6, to: 8, author: FRIEND },
			{ from: 10, to: 11, author: FRIEND },
		]);
	});

	it("joins one person's neighbouring runs and skips deleted text", () => {
		const doc = shared();
		doc.getText(BODY).delete(6, 7);

		expect(
			authorRanges(
				doc.getText(BODY),
				doc.getMap(USERS),
				[{ from: 0, to: 11 }],
				"p1",
			),
		).toEqual([{ from: 0, to: 11, author: OWNER }]);
	});

	it("leaves a client nobody named, or named with junk, untinted", () => {
		const doc = shared();
		const users = doc.getMap(USERS);
		users.delete("2");
		users.set("3", "owner");

		expect(authorOf(users, 2)).toBeNull();
		expect(authorOf(users, 3)).toBeNull();
		expect(
			authorRanges(doc.getText(BODY), users, [{ from: 0, to: 18 }], "p1"),
		).toEqual([{ from: 0, to: 6, author: OWNER }]);
	});
});
