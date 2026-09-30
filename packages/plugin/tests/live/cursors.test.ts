import {
	converge,
	type,
	useLiveRoom,
	waitUntil,
} from "@tests/helpers/live-session";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { watchCursor } from "@/live/text/cursors";

const live = useLiveRoom();

describe("a watched cursor", () => {
	it("moves with edits before it, which change no awareness state", async () => {
		const a = await live.synced("hello");
		const b = await live.synced("hello");
		const text = b.session.model.text;
		const head = Y.relativePositionToJSON(
			Y.createRelativePositionFromTypeIndex(text, 3),
		);
		b.session.awareness.setLocalStateField("user", { key: "bee", name: "B" });
		b.session.awareness.setLocalStateField("cursor", { anchor: head, head });
		const cursor = watchCursor(a.session, "bee");
		await waitUntil(() => expect(cursor.at()).toBe(3));
		expect(cursor.present()).toBe(true);

		const changed = vi.fn();
		const unwatch = cursor.watch(changed);
		type(b, 0, ">>");
		await converge(">>hello", a, b);

		expect(cursor.at()).toBe(5);
		expect(changed).toHaveBeenCalled();
		unwatch();
	});
});
