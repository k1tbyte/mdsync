import { defaultDeviceName } from "./device";
import type {
	Manifest,
	ManifestAuthor,
	ManifestEntry,
	SessionState,
} from "./types";

export interface LastEdit extends ManifestAuthor {
	/** The file's mtime as published. */
	at: number;
}

/** Who a session publishes as: its share's person, else the device. */
export function publisher(
	state: Pick<SessionState, "deviceId" | "deviceName">,
	author: ManifestAuthor | undefined,
): ManifestAuthor {
	return (
		author ?? {
			key: state.deviceId,
			name: state.deviceName?.trim() || defaultDeviceName(),
		}
	);
}

/**
 * Entries this publish changed are the author's; the rest keep their parent's
 * author. The table only grows, so an unchanged entry stays byte-identical and
 * an index read from any earlier manifest still names the same person.
 */
export function attribute(
	files: Record<string, ManifestEntry>,
	parent: Manifest | null,
	author: ManifestAuthor,
): { files: Record<string, ManifestEntry>; authors: ManifestAuthor[] } {
	const authors = [...(parent?.authors ?? [])];
	let index = authors.findIndex(({ key }) => key === author.key);
	if (index < 0) index = authors.push(author) - 1;
	else authors[index] = author;
	const out: Record<string, ManifestEntry> = {};
	for (const [path, entry] of Object.entries(files)) {
		const before = parent?.files[path];
		const by = before?.hash === entry.hash ? before.by : index;
		out[path] = {
			...withoutAuthor(entry),
			...(by === undefined ? {} : { by }),
		};
	}
	return { files: out, authors };
}

/** Who last published the entry, as its manifest names them; null when unknown. */
export function authorOf(
	manifest: Manifest | null,
	entry: ManifestEntry | undefined,
): ManifestAuthor | null {
	if (!manifest || entry?.by === undefined) return null;
	return manifest.authors?.[entry.by] ?? null;
}

/** The paths among `paths` whose current content someone other than `me` published. */
export function publishedByOthers(
	manifest: Manifest | null,
	paths: Iterable<string>,
	me: string,
): string[] {
	return [...paths].filter((path) => {
		const author = authorOf(manifest, manifest?.files[path]);
		return author !== null && author.key !== me;
	});
}

function withoutAuthor({ by: _, ...entry }: ManifestEntry): ManifestEntry {
	return entry;
}
