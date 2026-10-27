import {
	type EMergeSide,
	type ESideStatus,
	MERGE_SIDES,
	type MergeChange,
	type SideStatus,
	type Span,
	type Taken,
} from "@/features/sync";

export type StatusPatch = Partial<Record<EMergeSide, ESideStatus>>;
/** `null` withdraws a side's contribution. */
export type TakenPatch = Partial<Record<EMergeSide, Span | null>>;

export interface EditPlan {
	from: number;
	to: number;
	insert: string;
	/** Where the change sits once the edit is in; absent when mapping alone places it. */
	result?: Span;
	taken: TakenPatch;
}

/** The subset of a CodeMirror `Text` the model needs, so it stays free of the editor. */
export interface LineDoc {
	length: number;
	lineAt(pos: number): { from: number; to: number };
}

interface LineEdit {
	from: number;
	to: number;
	insert: string;
	result: Span;
}

function otherSide(side: EMergeSide): EMergeSide {
	return side === "local" ? "remote" : "local";
}

export function sameStatus(a: SideStatus, b: SideStatus | undefined): boolean {
	return b !== undefined && MERGE_SIDES.every((side) => a[side] === b[side]);
}

export function patchTaken(taken: Taken, patch: TakenPatch): Taken {
	const next: Partial<Record<EMergeSide, Span>> = { ...taken };
	for (const side of MERGE_SIDES) {
		const span = patch[side];
		if (span === undefined) continue;
		if (span === null) delete next[side];
		else next[side] = span;
	}
	return next;
}

/** Widens a span to whole lines: from a line start to the next line start or the doc end. */
export function snapToLines(doc: LineDoc, span: Span): Span {
	if (span.to <= span.from) {
		// An empty span sits before a line, or after the last line of a file without a final newline;
		// mid-line it moves to the next line.
		const line = doc.lineAt(span.from);
		const at =
			span.from === line.from || span.from === doc.length
				? span.from
				: Math.min(line.to + 1, doc.length);
		return { from: at, to: at };
	}
	const from = doc.lineAt(span.from).from;
	const endLine = doc.lineAt(span.to);
	const to =
		endLine.from === span.to ? span.to : Math.min(endLine.to + 1, doc.length);
	return { from, to };
}

/** A conflict whose other side is already in gets this side appended below it, so click order is line order. */
export function applyPlan(
	doc: LineDoc,
	change: MergeChange,
	side: EMergeSide,
	sideLines: readonly string[],
): EditPlan {
	const span = snapToLines(doc, change.result);
	const otherSideName = otherSide(side);
	const otherApplied = change.status[otherSideName] === "applied";

	if (!change.conflict && otherApplied) {
		const otherPart = change.taken[otherSideName];
		if (otherPart) {
			return {
				from: otherPart.from,
				to: otherPart.from,
				insert: "",
				result: change.result,
				taken: { [side]: otherPart },
			};
		}
	}

	const append = otherApplied;
	if (append && sideLines.length === 0) {
		return {
			from: span.to,
			to: span.to,
			insert: "",
			result: span,
			taken: { [side]: { from: span.to, to: span.to } },
		};
	}
	const edit = replaceLines(
		doc,
		append ? { from: span.to, to: span.to } : span,
		sideLines,
		change.endsAtEof,
		append || emptyResult(change),
	);
	return {
		...edit,
		// An emptied span at the end of the file sits before the line break the new lines bring, not at a
		// line start: they are the whole result, or reverting would snap it onto the line above.
		result:
			append && doc.lineAt(span.from).from === span.from
				? { from: span.from, to: edit.result.to }
				: edit.result,
		taken: { [side]: edit.result },
	};
}

/** With the other side still in, only this side's lines go; otherwise the base lines return. */
export function revertPlan(
	doc: LineDoc,
	change: MergeChange,
	side: EMergeSide,
	baseLines: readonly string[],
): EditPlan {
	const part = change.taken[side];
	const otherSideName = otherSide(side);
	const otherApplied = change.status[otherSideName] === "applied";

	if (!change.conflict && otherApplied) {
		const otherPart = change.taken[otherSideName];
		if (
			part &&
			otherPart &&
			part.from === otherPart.from &&
			part.to === otherPart.to
		) {
			return {
				from: part.from,
				to: part.from,
				insert: "",
				taken: { [side]: null },
			};
		}
	}

	if (part && otherApplied) {
		if (part.from === part.to && change[side][0] === change[side][1])
			return {
				from: part.from,
				to: part.from,
				insert: "",
				taken: { [side]: null },
			};
		const edit = replaceLines(
			doc,
			snapToLines(doc, part),
			[],
			change.endsAtEof,
		);
		return {
			from: edit.from,
			to: edit.to,
			insert: "",
			taken: { [side]: null },
		};
	}
	const edit = replaceLines(
		doc,
		snapToLines(doc, change.result),
		baseLines,
		change.endsAtEof,
		emptyResult(change),
	);
	return { ...edit, taken: { [side]: null } };
}

function replaceLines(
	doc: LineDoc,
	target: Span,
	lines: readonly string[],
	endsAtEof: boolean,
	afterLastLine = false,
): LineEdit {
	let { from } = target;
	const { to } = target;
	const atEnd = endsAtEof && to === doc.length;
	let insert = "";
	let prefix = "";
	if (lines.length === 0) {
		// The final empty line is significant too: removing it removes the final newline.
		if (atEnd && from > 0 && (from < to || doc.lineAt(from).from === from))
			from -= 1;
	} else {
		if (
			from === to &&
			((atEnd && afterLastLine) || doc.lineAt(from).from !== from)
		)
			prefix = "\n";
		insert = `${prefix}${lines.join("\n")}${atEnd ? "" : "\n"}`;
	}
	return {
		from,
		to,
		insert,
		result: { from: from + prefix.length, to: from + insert.length },
	};
}

function emptyResult(change: MergeChange): boolean {
	const applied = MERGE_SIDES.filter(
		(side) => change.status[side] === "applied",
	);
	return applied.length > 0
		? applied.every((side) => change[side][0] === change[side][1])
		: change.base[0] === change.base[1];
}
