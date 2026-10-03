import { deviceLabel } from "@/sync/device";
import { movesByPath } from "@/sync/moves";
import type { Conflict, FileChange, Move } from "@/sync/types";
import { type ChangeAction, changeActionOf } from "@/ui/common";
import type { FileRow } from "./types";

export const STATUS_LETTERS: Record<ChangeAction, string> = {
	add: "A",
	modify: "M",
	delete: "D",
};

export const STATUS_CLASSES: Record<ChangeAction, string> = {
	add: "mdsync-status-add",
	modify: "mdsync-status-modify",
	delete: "mdsync-status-delete",
};

export function rowFromChange(
	change: FileChange,
	size?: number,
	previousSize?: number,
): FileRow {
	const action = changeActionOf(change.type);
	return {
		path: change.path,
		size,
		sizeDelta:
			action === "modify" && size !== undefined && previousSize !== undefined
				? size - previousSize
				: undefined,
		statusLetter: action ? STATUS_LETTERS[action] : "?",
		statusClass: action ? STATUS_CLASSES[action] : "",
		isConflict: false,
	};
}

/** A move's changes fold into one row at its new path. */
export function foldMoves(
	changes: readonly FileChange[],
	moves: readonly Move[],
	toRow: (change: FileChange) => FileRow,
): FileRow[] {
	const moveOf = movesByPath(moves);
	const folded = new Set<Move>();
	const rows: FileRow[] = [];
	for (const change of changes) {
		const move = moveOf.get(change.path);
		if (!move) {
			rows.push(toRow(change));
			continue;
		}
		if (folded.has(move)) continue;
		folded.add(move);
		rows.push({
			...toRow(change),
			path: move.to,
			from: move.from,
			sizeDelta: undefined,
			statusLetter: "R",
			statusClass: "mdsync-status-move",
		});
	}
	return rows;
}

export function rowFromConflict(conflict: Conflict, size?: number): FileRow {
	return {
		path: conflict.path,
		size,
		statusLetter: "C",
		statusClass: "mdsync-status-conflict",
		isConflict: true,
	};
}

/** Prefers this device's own name over the label stored with the entry. */
export function deviceText(
	entry: { deviceId: string; deviceName?: string },
	current: { id: string; name: string } | null | undefined,
): string {
	if (current && current.id === entry.deviceId) return current.name;
	return deviceLabel(entry.deviceId, entry.deviceName);
}
