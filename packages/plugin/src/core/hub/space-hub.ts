import type { ClientFrame, ServerFrame } from "@mdsync/protocol";

/** The relay's own state and the cold-sync ping; frames go to `SpaceListener`s. */
export interface HubListener {
	/** Another device pushed into any space this device holds. */
	onSignal?(spaceId: string): void;
	/** The relay cut a space's grant: revoked, or a token too new for it yet. */
	onRevoked?(): void;
	/** The vault's socket; also reported on every restart, so listeners drop state tied to the old link. */
	onConnectionChange?(connected: boolean): void;
}

export interface SpaceListener {
	onFrame?(frame: ServerFrame): void;
	/** False on every restart of its socket and when the relay revokes the channel. */
	onConnectionChange?(connected: boolean): void;
}

/** A client frame before its socket's slot is known. */
export type SpaceFrame = ClientFrame extends infer F
	? F extends ClientFrame
		? Omit<F, "slot">
		: never
	: never;

/** A space's channel on whichever socket holds it; frames sent while it is down are dropped. */
export interface SpaceHub {
	send(frame: SpaceFrame): void;
	isConnected(): boolean;
	listen(listener: SpaceListener): () => void;
}

/** The hub as live editing and presence see it: one channel per space. */
export interface SpaceHubs {
	space(spaceId: string): SpaceHub;
	listen(listener: HubListener): () => void;
}
