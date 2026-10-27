import {
	embeddedFiles,
	readDrawing,
	type SceneElement,
	withEmbeddedFiles,
	withScene,
} from "./format";

const DATA_HEADING = "# Excalidraw Data";

/** Excalidraw's own rule: the higher version, then the lower nonce. */
export function wins(a: SceneElement, b: SceneElement): boolean {
	return a.version !== b.version
		? a.version > b.version
		: a.versionNonce < b.versionNonce;
}

/**
 * Three-way by element: both-sides elements keep the winner; one held by a single side stays unless the other
 * dropped it unchanged since `base`.
 */
export function mergeElements(
	base: readonly SceneElement[],
	local: readonly SceneElement[],
	remote: readonly SceneElement[],
): SceneElement[] {
	const before = byId(base);
	const theirs = byId(remote);
	const out: SceneElement[] = [];
	for (const element of local) {
		const other = theirs.get(element.id);
		theirs.delete(element.id);
		if (other) out.push(wins(other, element) ? other : element);
		else if (!unchanged(element, before)) out.push(element);
	}
	for (const element of theirs.values()) {
		if (!unchanged(element, before)) out.push(element);
	}
	return byIndex(out);
}

/** Null when the notes around the scene changed on both sides. Images either side added keep their links. */
export function mergeDrawings(
	base: string,
	local: string,
	remote: string,
): string | null {
	const was = readDrawing(base);
	const mine = readDrawing(local);
	const theirs = readDrawing(remote);
	if (!was || !mine || !theirs) return null;
	const [baseNotes, localNotes, remoteNotes] = [base, local, remote].map(
		notesOf,
	);
	const theirNotes = remoteNotes !== baseNotes && remoteNotes !== localNotes;
	if (theirNotes && localNotes !== baseNotes) return null;
	const [hostText, host, guestText, guest] = theirNotes
		? [remote, theirs, local, mine]
		: [local, mine, remote, theirs];
	const elements = mergeElements(
		was.scene.elements,
		mine.scene.elements,
		theirs.scene.elements,
	);
	const files = { ...guest.scene.files, ...host.scene.files };
	const merged = withScene(hostText, host, { ...host.scene, elements, files });
	const known = embeddedFiles(merged);
	const missing = [...embeddedFiles(guestText)]
		.filter(([id]) => !known.has(id))
		.map(([, line]) => line);
	return withEmbeddedFiles(merged, missing);
}

/** What a person wrote around the drawing: everything above its data. */
function notesOf(text: string): string {
	const at = text.indexOf(DATA_HEADING);
	return at < 0 ? text : text.slice(0, at);
}

function unchanged(
	element: SceneElement,
	before: ReadonlyMap<string, SceneElement>,
): boolean {
	const was = before.get(element.id);
	return (
		was !== undefined &&
		was.version === element.version &&
		was.versionNonce === element.versionNonce
	);
}

function byId(elements: readonly SceneElement[]): Map<string, SceneElement> {
	return new Map(elements.map((element) => [element.id, element]));
}

/** Z-order by fractional index; the plugin repairs clashing ones on load. */
function byIndex(elements: SceneElement[]): SceneElement[] {
	return elements
		.map((element, at) => ({ element, at }))
		.sort((a, b) => {
			const x = a.element.index;
			const y = b.element.index;
			if (x === y || x === undefined || y === undefined) return a.at - b.at;
			return x < y ? -1 : 1;
		})
		.map(({ element }) => element);
}
