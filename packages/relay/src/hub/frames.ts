/** Server frames the hub builds itself, worded once for channel and document logic. */

import {
	CHANNEL_DOC,
	EFrame,
	type Refusal,
	type ServerFrame,
} from "@obsync/protocol";

import type { Grant } from "./peer";

type Unaddressed<F> = F extends ServerFrame ? Omit<F, "slot" | "doc"> : never;
export type ServerBody = Unaddressed<ServerFrame>;

/** `broadcast` rewrites the slot per recipient, so 0 is only a placeholder there. */
export function addressed(
	body: ServerBody,
	doc = CHANNEL_DOC,
	slot = 0,
): ServerFrame {
	return { ...body, slot, doc } as ServerFrame;
}

export function signalFrame(from: number): ServerBody {
	return { type: EFrame.Signal, from };
}

export function joinFrame(from: number, grant: Grant): ServerBody {
	return { type: EFrame.Join, from, who: grant.who, name: grant.name ?? "" };
}

/** Someone already on the channel, told to a newcomer. */
export function hereFrame(from: number, grant: Grant): ServerBody {
	return { type: EFrame.Here, from, who: grant.who, name: grant.name ?? "" };
}

export function leaveFrame(from: number): ServerBody {
	return { type: EFrame.Leave, from };
}

export function peerFrame(from: number, payload: Uint8Array): ServerBody {
	return { type: EFrame.Peer, from, payload };
}

export function movedFrame(
	slot: number,
	doc: string,
	{ target, note }: { target: string; note: Uint8Array },
): ServerFrame {
	return { type: EFrame.Moved, slot, doc, target, note };
}

export function refusedFrame(
	slot: number,
	doc: string,
	reason: Refusal,
): ServerFrame {
	return { type: EFrame.Refused, slot, doc, reason };
}

export function revokedFrame(slot: number): ServerFrame {
	return { type: EFrame.Revoked, slot, doc: CHANNEL_DOC };
}
