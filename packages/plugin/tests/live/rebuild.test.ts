import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { USERS } from "@/live/authors";
import { BODY, rebuild } from "@/live/text/rebuild";

function authored(doc: Y.Doc): [number, string][] {
	const runs: [number, string][] = [];
	for (let item = doc.getText(BODY)._start; item; item = item.right) {
		if (!item.deleted)
			runs.push([item.id.client, item.content.getContent().join("")]);
	}
	return runs;
}

function opened(update: Uint8Array): Y.Doc {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, update);
	return doc;
}

describe("rebuild", () => {
	it("keeps the text and who typed each part, without the deleted history", () => {
		const laptop = new Y.Doc();
		laptop.clientID = 1;
		const desktop = new Y.Doc();
		desktop.clientID = 2;
		laptop.getText(BODY).insert(0, "hello world");
		Y.applyUpdate(desktop, Y.encodeStateAsUpdate(laptop));
		desktop.getText(BODY).insert(5, " dear");
		desktop.getText(BODY).delete(0, 1);
		desktop.getText(BODY).insert(0, "H");
		const owner = { person: "owner", name: "Owner" };
		const guest = { person: "p1", name: "Friend" };
		desktop.getMap(USERS).set("1", owner);
		desktop.getMap(USERS).set("2", guest);
		// A session that only deleted, or whose text is all gone.
		desktop.getMap(USERS).set("3", guest);

		const fresh = opened(rebuild(desktop));

		expect(fresh.getText(BODY).toString()).toBe("Hello dear world");
		expect(authored(fresh)).toEqual([
			[2, "H"],
			[1, "ello"],
			[2, " dear"],
			[1, " world"],
		]);
		expect(fresh.getMap(USERS).toJSON()).toEqual({ "1": owner, "2": guest });
	});

	it("sheds the tombstones of a long edit history", () => {
		const doc = new Y.Doc();
		const text = doc.getText(BODY);
		for (let i = 0; i < 2000; i++) {
			text.insert(text.length, "ab");
			text.delete(text.length - 1, 1);
		}

		const seed = rebuild(doc);

		expect(opened(seed).getText(BODY).toString()).toBe("a".repeat(2000));
		expect(seed.length).toBeLessThan(Y.encodeStateAsUpdate(doc).length / 2);
	});
});
