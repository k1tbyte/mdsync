/**
 * A renamed live note takes its open room along: it rotates into the new path's first free generation with
 * a sealed note of that path, so every device renames its file and follows.
 */

import { EFrame } from "@obsync/protocol";
import { seal, unseal } from "@/crypto/seal";
import type { SpaceHub } from "@/hub";
import { hasLiveExtension } from "@/live/doc-types";
import type { LiveSession } from "@/live/session";
import type { Rotation } from "@/live/session/session-deps";
import { hasDotSegment, normalizePath } from "@/shared";
import { bytesToText, textToBytes } from "@/sync/content";
import { insideOf, vaultPathOf } from "@/sync/space";
import { docIdIn, type LiveSpace } from "./space";

/** Generations one path may have gone through; past this the rename is left to the file sync. */
const MAX_WALK = 32;
const PROBE_TIMEOUT_MS = 10_000;
/** A room busy with typing settles within a flush or two. */
const RETRY_MS = 500;
const ATTEMPTS = 20;

export interface MoveNote {
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
	// A reader never moves a room: its note starts over at the new path at once.
	if (space.readOnly) return "refused";
	for (let attempt = 0; attempt < ATTEMPTS && still(); attempt++) {
		const generation = await freeGeneration(hub, space, path);
		// Taken: a room readers reach already holds this path, another note's.
		if (generation === "taken") return "refused";
		if (generation !== "unanswered") {
			const note = JSON.stringify({ path: insideOf(space, path), generation });
			const outcome = await session.rotate(
				await docIdIn(space, path, generation),
				await seal(space.keys, textToBytes(note), `moved:${session.docId}`),
			);
			if (outcome === "moved") return outcome;
		}
		await new Promise((resolve) => window.setTimeout(resolve, RETRY_MS));
	}
	return "busy";
}

/**
 * Where a room moved with its file; null for a plain rotation, or a note that names another room than the
 * pointer's.
 */
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
		note = JSON.parse(bytesToText(opened));
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
				switch (frame.type) {
					case EFrame.Moved:
						return done("moved");
					case EFrame.Refused:
						return done("unanswered");
					case EFrame.State:
						hub.send({ type: EFrame.Unsub, doc });
						return done(frame.head === 0 ? "free" : "taken");
				}
			},
			onConnectionChange: () => done("unanswered"),
		});
		const timer = window.setTimeout(() => {
			hub.send({ type: EFrame.Unsub, doc });
			done("unanswered");
		}, PROBE_TIMEOUT_MS);
		hub.send({ type: EFrame.Sub, doc, since: 0 });
	});
}

/** Inside the space, a note, and nowhere the sync would not go. */
function isNotePath(inside: unknown): inside is string {
	return (
		typeof inside === "string" &&
		inside === normalizePath(inside) &&
		hasLiveExtension(inside) &&
		!hasDotSegment(inside) &&
		!inside.split("/").includes("")
	);
}

function isGeneration(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
