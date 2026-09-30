/**
 * A live note renamed while its room is open takes the room along: the room
 * rotates into the new path's first free generation and leaves a sealed note
 * of that path, so every device in it renames its file and follows.
 */

import { EFrame } from "@obsync/protocol";

import type { SpaceHub } from "@/hub/connection";
import { hasDotSegment, normalizePath } from "@/shared/path";

import { seal, unseal } from "./seal";
import type { LiveSession } from "./session";
import type { Rotation } from "./session-deps";
import { docIdIn, insideOf, type LiveSpace, vaultPathOf } from "./space";

/** Generations one path may have gone through; past this the rename is left to the file sync. */
const MAX_WALK = 32;
const PROBE_TIMEOUT_MS = 10_000;
/** A room busy with typing settles within a flush or two. */
const RETRY_MS = 500;
const ATTEMPTS = 20;
const LIVE_EXTENSION = ".md";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface MoveNote {
	/** The vault path the room moved to. */
	path: string;
	generation: number;
}

type Probe = "free" | "moved" | "taken" | "unanswered";

/** Moves the room of a note renamed to `path` there; "moved" may name another device's rename that won the hub. */
export async function moveRoom(
	session: LiveSession,
	space: LiveSpace,
	hub: SpaceHub,
	path: string,
	still: () => boolean,
): Promise<Rotation> {
	for (let attempt = 0; attempt < ATTEMPTS && still(); attempt++) {
		const generation = await freeGeneration(hub, space, path);
		// Taken: a room readers reach already holds this path, another note's.
		if (generation === "taken") return "refused";
		if (generation !== "unanswered") {
			const note = JSON.stringify({ path: insideOf(space, path), generation });
			const outcome = await session.rotate(
				await docIdIn(space, path, generation),
				await seal(space.keys, encoder.encode(note), `moved:${session.docId}`),
			);
			if (outcome === "moved") return outcome;
		}
		await new Promise((resolve) => window.setTimeout(resolve, RETRY_MS));
	}
	return "busy";
}

/** Where a room moved with its file; null for a plain rotation, or a note that does not name the room it points at. */
export async function movedWith(
	space: LiveSpace,
	session: LiveSession,
): Promise<MoveNote | null> {
	const { movedTo, moveNote } = session;
	if (!movedTo || !moveNote?.length) return null;
	const opened = await unseal(space.keys, moveNote, `moved:${session.docId}`);
	if (!opened) return null;
	let note: Partial<MoveNote>;
	try {
		note = JSON.parse(decoder.decode(opened));
	} catch {
		return null;
	}
	const { path: inside, generation } = note;
	if (!isNotePath(inside) || !isGeneration(generation)) return null;
	const path = vaultPathOf(space, inside);
	const target = await docIdIn(space, path, generation);
	return target === movedTo ? { path, generation } : null;
}

/** Readers step past every pointer to the next generation, so the first one with no room is where they arrive. */
async function freeGeneration(
	hub: SpaceHub,
	space: LiveSpace,
	path: string,
): Promise<number | "taken" | "unanswered"> {
	for (let generation = 0; generation < MAX_WALK; generation++) {
		const answer = await probe(hub, await docIdIn(space, path, generation));
		if (answer === "free") return generation;
		if (answer !== "moved") return answer;
	}
	return "taken";
}

function probe(hub: SpaceHub, doc: string): Promise<Probe> {
	if (!hub.isConnected()) return Promise.resolve("unanswered");
	return new Promise((resolve) => {
		const done = (answer: Probe) => {
			unlisten();
			window.clearTimeout(timer);
			resolve(answer);
		};
		const unlisten = hub.listen({
			onFrame: (frame) => {
				if (frame.doc !== doc) return;
				if (frame.type === EFrame.Moved) done("moved");
				else if (frame.type === EFrame.Refused) done("unanswered");
				else if (frame.type === EFrame.State) {
					hub.send({ type: EFrame.Unsub, doc });
					done(frame.head === 0 ? "free" : "taken");
				}
			},
			onConnectionChange: () => done("unanswered"),
		});
		const timer = window.setTimeout(() => done("unanswered"), PROBE_TIMEOUT_MS);
		hub.send({ type: EFrame.Sub, doc, since: 0 });
	});
}

/** Inside the space, a note, and nowhere the sync would not go. */
function isNotePath(inside: unknown): inside is string {
	return (
		typeof inside === "string" &&
		inside === normalizePath(inside) &&
		inside.endsWith(LIVE_EXTENSION) &&
		!hasDotSegment(inside) &&
		!inside.split("/").includes("")
	);
}

function isGeneration(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
