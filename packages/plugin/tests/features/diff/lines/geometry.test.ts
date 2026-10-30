import { BlockType, type EditorView, WidgetType } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { spanBounds } from "@/features/diff/lines/geometry";
import { SourceBlockWidget } from "@/features/diff/lines/source-widget";

class RowWidget extends WidgetType {
	toDOM(): HTMLElement {
		throw new Error("never drawn");
	}
}

const card = (key: string) =>
	new SourceBlockWidget({
		key,
		tone: "removed",
		head: { text: "Line 2 · removed" },
		lines: ["gone"],
		firstLine: 1,
	});

interface Part {
	from: number;
	height: number;
	widget?: WidgetType;
}

/** Line 2 runs from 4 to the file's end at 5; `parts` stack down from its top, the text where `widget` is left out. */
function lineOf(parts: Part[]) {
	let top = 20;
	const type = parts.map(({ from, height, widget }) => {
		const part = {
			from,
			widget: widget ?? null,
			type: widget ? BlockType.WidgetBefore : BlockType.Text,
			top,
			bottom: top + height,
		};
		top += height;
		return part;
	});
	const block = {
		from: 4,
		top: 20,
		bottom: top,
		type: type.length > 1 ? type : BlockType.Text,
	};
	return { lineBlockAt: () => block } as unknown as EditorView;
}

const text: Part = { from: 4, height: 20 };
const atLineStart = { from: 4, to: 4 };

describe("spanBounds of an empty span", () => {
	it("is a point at the line's top", () => {
		expect(spanBounds(lineOf([text]), atLineStart)).toEqual({
			top: 20,
			bottom: 20,
		});
	});

	it("is the card standing in the change's place, not a row above it", () => {
		const view = lineOf([
			{ from: 4, height: 30, widget: new RowWidget() },
			{ from: 4, height: 50, widget: card("0") },
			text,
		]);
		expect(spanBounds(view, atLineStart)).toEqual({ top: 50, bottom: 100 });
	});

	it("leaves the card closing the file to its own change", () => {
		const view = lineOf([text, { from: 5, height: 50, widget: card("1") }]);
		expect(spanBounds(view, atLineStart)).toEqual({ top: 20, bottom: 20 });
	});

	it("covers every card at one place, never picks one", () => {
		const view = lineOf([
			{ from: 4, height: 40, widget: card("0") },
			{ from: 4, height: 30, widget: card("1") },
			text,
		]);
		expect(spanBounds(view, atLineStart)).toEqual({ top: 20, bottom: 90 });
	});
});
