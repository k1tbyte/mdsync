import { EditorState, type TransactionSpec } from "@codemirror/state";
import { type DecorationSet, ViewPlugin } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { USERS } from "@/live/authors";
import { authorMarks } from "@/live/text/author-marks";
import { personTint } from "@/shared/colors";

const REPAINT_MS = 250;

interface Painter {
	decorations: DecorationSet;
	update(update: object): void;
	destroy(): void;
}

function typed(doc: Y.Doc, person: string, at: number, text: string): void {
	doc.getMap(USERS).set(String(doc.clientID), {
		person,
		name: person.toUpperCase(),
	});
	doc.getText("t").insert(at, text);
}

function room() {
	const ann = new Y.Doc();
	typed(ann, "ann", 0, "hello ");
	const bob = new Y.Doc();
	Y.applyUpdate(bob, Y.encodeStateAsUpdate(ann));
	typed(bob, "bob", 6, "world");
	const doc = new Y.Doc();
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(bob));
	return { text: doc.getText("t"), users: doc.getMap(USERS) };
}

function painted(
	me: string,
	{ text, users } = room(),
	nameOf: (person: string) => string | null = () => null,
) {
	const fromClass = vi.spyOn(ViewPlugin, "fromClass");
	authorMarks(text, users, me, nameOf);
	const [Painter] = fromClass.mock.calls.at(-1) as unknown as [
		new (view: object) => Painter,
	];
	let state = EditorState.create({ doc: text.toString() });
	const view = {
		get state() {
			return state;
		},
		get visibleRanges() {
			return [{ from: 0, to: state.doc.length }];
		},
		dispatch: vi.fn(),
	};
	const painter = new Painter(view);
	const edit = (spec: TransactionSpec) => {
		const transaction = state.update(spec);
		state = transaction.state;
		painter.update({
			view,
			transactions: [transaction],
			docChanged: transaction.docChanged,
			viewportChanged: false,
			changes: transaction.changes,
		});
	};
	return {
		text,
		view,
		painter,
		edit,
		repaint: () => edit(view.dispatch.mock.calls.at(-1)?.[0]),
		marks() {
			const out: { from: number; to: number; style: string; title: string }[] =
				[];
			painter.decorations.between(0, state.doc.length, (from, to, mark) => {
				const { style, title } = mark.spec.attributes;
				out.push({ from, to, style, title });
			});
			return out;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("author marks", () => {
	it("tint what others typed with their own colour, named as the relay knows them", () => {
		const view = painted("carol", room(), (person) =>
			person === "bob" ? "Bob from the relay" : null,
		);

		expect(view.marks()).toEqual([
			{
				from: 0,
				to: 6,
				style: `background-color: ${personTint("ann")}`,
				title: "ANN",
			},
			{
				from: 6,
				to: 11,
				style: `background-color: ${personTint("bob")}`,
				title: "Bob from the relay",
			},
		]);
		expect(personTint("ann")).not.toBe(personTint("bob"));
	});

	it("leave the device's own person untinted, and text nobody named", () => {
		expect(
			painted("ann")
				.marks()
				.map(({ from, to }) => [from, to]),
		).toEqual([[6, 11]]);
		const unnamed = room();
		unnamed.users.clear();
		expect(painted("carol", unnamed).marks()).toEqual([]);
	});

	it("keep a tint on its text while typing, and repaint from the room once per window", () => {
		vi.useFakeTimers();
		const view = painted("ann");
		view.text.insert(0, "XY");
		view.edit({ changes: { from: 0, insert: "XY" } });
		view.edit({ changes: { from: 0, insert: "Z" } });

		expect(view.marks().map(({ from }) => from)).toEqual([9]);
		expect(view.view.dispatch).not.toHaveBeenCalled();
		vi.advanceTimersByTime(REPAINT_MS);
		expect(view.view.dispatch).toHaveBeenCalledOnce();

		view.text.insert(0, "Z");
		view.repaint();
		expect(view.marks().map(({ from }) => from)).toEqual([9]);
	});

	it("keep the mapped tint while the room and the editor disagree, and ask again", () => {
		vi.useFakeTimers();
		const view = painted("ann");
		view.edit({ changes: { from: 0, insert: "XY" } });
		vi.advanceTimersByTime(REPAINT_MS);
		view.repaint();

		expect(view.marks().map(({ from }) => from)).toEqual([8]);
		vi.advanceTimersByTime(REPAINT_MS);
		expect(view.view.dispatch).toHaveBeenCalledTimes(2);

		view.text.insert(0, "XY");
		view.repaint();
		expect(view.marks().map(({ from }) => from)).toEqual([8]);
	});

	it("stop repainting once the editor is gone", () => {
		vi.useFakeTimers();
		const view = painted("ann");
		view.edit({ changes: { from: 0, insert: "XY" } });

		view.painter.destroy();
		vi.advanceTimersByTime(REPAINT_MS);

		expect(view.view.dispatch).not.toHaveBeenCalled();
	});
});
