import {
	formatBytes,
	formatDay,
	formatRelativeTime,
	normalizePath,
} from "@/core/shared";
import type { DeletedFile } from "@/features/sync";
import { deviceText } from "../changes/row-formatter";

export interface TrashRow {
	path: string;
	hash: string;
	size: number;
	/** Bare age, with no "deleted"/"last seen" prefix, for use inside a sentence. */
	age: string;
	title: string;
	/** Short enough to head a diff pane: "deleted 3 days ago". */
	label: string;
	meta: string;
	/** Back in the vault but unpushed, else how long history keeps it. */
	note: TrashNote | null;
	pinned: boolean;
}

export interface TrashNote {
	text: string;
	tone: "plain" | "soon" | "pinned" | "restored";
	icon: string;
}

/** Time left at which a version's end is worth a colour. */
const SOON_MS = 7 * 24 * 60 * 60_000;

export interface TrashRowOptions {
	now?: number;
	/** Lets rows name this device instead of showing a raw id. */
	currentDevice?: { id: string; name: string } | null;
	/** Whether a file exists in the vault right now. */
	inVault?: (path: string) => boolean;
}

export function buildTrashRows(
	files: readonly DeletedFile[],
	options: TrashRowOptions,
): TrashRow[] {
	const now = options.now ?? Date.now();
	return files.map((file) => {
		const age = formatRelativeTime(file.createdAt, now);
		const seenIn = file.label?.trim();
		const label =
			file.source === "pinned"
				? `last seen ${seenIn ? `in "${seenIn}"` : age}`
				: `deleted ${age}`;
		return {
			path: file.path,
			hash: file.entry.hash,
			size: file.entry.size,
			age,
			title: file.path,
			label,
			// Size before the device: a narrow pane cuts the end.
			meta: [
				label,
				formatBytes(file.entry.size),
				deviceText(file, options.currentDevice),
			].join(" · "),
			note: options.inVault?.(file.path)
				? {
						text: "Restored here, not pushed yet",
						tone: "restored",
						icon: "check",
					}
				: retentionNote(file, now),
			pinned: file.pinned,
		};
	});
}

function retentionNote(file: DeletedFile, now: number): TrashNote | null {
	const text = retentionText(file, now);
	if (text === null) return null;
	if (file.pinned) return { text, tone: "pinned", icon: "pin" };
	const soon = file.keptUntil !== null && file.keptUntil - now <= SOON_MS;
	return { text, tone: soon ? "soon" : "plain", icon: "hourglass" };
}

/**
 * Vault-relative restore target, or null for a path escaping the vault or naming a folder; `writeBinary`
 * creates folders.
 */
export function resolveRestoreTarget(input: string): string | null {
	const normalized = normalizePath(input.trim());
	if (!normalized) return null;
	const segments = normalized.split("/");
	// "." and ".." name directories, and an empty segment means a trailing slash.
	if (
		segments.some(
			(segment) => segment === "" || segment === "." || segment === "..",
		)
	) {
		return null;
	}
	return normalized;
}

/** Retention promises "at least": GC may keep a version past this date, never drops it before. */
export function retentionText(
	file: Pick<DeletedFile, "pinned" | "keptUntil">,
	now: number,
): string | null {
	if (file.pinned) return "Kept by a pinned snapshot";
	if (file.keptUntil === null) return null;
	return `Kept until ${formatDay(file.keptUntil, now, false)}`;
}
