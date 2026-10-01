import type { Refusal } from "@obsync/protocol";

import type { LiveKeys } from "@/crypto/live-keys";
import type { SpaceHub } from "@/hub";

import type { Author } from "@/live/authors";
import type { LiveKind, LiveModel } from "@/live/model";

/** "busy": not now - edits still staged or unacked, offline, or the answer was lost. */
export type Rotation = "moved" | "refused" | "busy";

/** Why a reader's note stays cold: nobody edits it live yet, or this copy and the room differ. */
export type Unfollowed = "empty" | "diverged";

export type Refused = Refusal | "unreadable";

export interface Follower {
	/** The disk is a version the space already has: the agreed text or the cold baseline. */
	unchanged(disk: string): Promise<boolean>;
	onCold(why: Unfollowed): void;
}

export interface LiveSessionDeps<M extends LiveModel> {
	kind: LiveKind<M>;
	keys: LiveKeys;
	hub: SpaceHub;
	/** Who this device types as: attribution maps its client id to them. */
	author: Author;
	/** The seq this device knew the room at; a room behind it lost its log. A successor starts at 1. */
	knownSeq?: number;
	/** The docId of the next generation, where a room that lost its log moves on. */
	successor(): Promise<string>;
	readDisk(): Promise<string>;
	/** What the disk last agreed on with everyone: the base of the merge. */
	readBase(): Promise<string>;
	/** The room now holds all of `agreed`: nothing local is staged, pending or unacked. */
	onAgreed(agreed: string, seq: number): void;
	/** The room was rebuilt elsewhere and now points at its successor. */
	onMoved(): void;
	/** The hub cannot carry this document, or this device cannot read it: it goes cold. */
	onRefused(reason: Refused): void;
	/** Set for a read-only person: see `FollowerSession`. */
	follower?: Follower;
	nameOf?(person: string): string | null;
}
