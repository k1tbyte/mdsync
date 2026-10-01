import { EFrame } from "@obsync/protocol";

import type { LiveKeys } from "@/crypto/live-keys";
import { seal } from "@/crypto/seal";
import type { SpaceFrame } from "@/hub";
import type { Rotation } from "./session-deps";

type RotateFrame = Omit<
	Extract<SpaceFrame, { type: typeof EFrame.Rotate }>,
	"doc"
>;

interface RotationIo {
	keys: LiveKeys;
	enqueue(step: () => unknown): void;
	/** Nothing of this device's outstanding, on a socket that is online. */
	ready(): boolean;
	online(): boolean;
	seq(): number;
	rebuild(): Uint8Array;
	send(frame: RotateFrame): void;
}

/** The one rotation this device asked the hub for, settled by the hub's answer or a lost socket. */
export class RoomRotation {
	private settle: ((outcome: Rotation) => void) | null = null;

	constructor(private readonly io: RotationIo) {}

	ask(target: string, note: Uint8Array): Promise<Rotation> {
		return new Promise((resolve) =>
			this.io.enqueue(async () => {
				try {
					await this.send(target, note, resolve);
				} catch (err) {
					// Settled all the same: a rename and the Rebuild command wait on it.
					resolve("busy");
					throw err;
				}
			}),
		);
	}

	end(outcome: Rotation): void {
		this.settle?.(outcome);
		this.settle = null;
	}

	private async send(
		target: string,
		note: Uint8Array,
		resolve: (outcome: Rotation) => void,
	): Promise<void> {
		if (!this.io.ready() || this.settle) return resolve("busy");
		const upto = this.io.seq();
		const payload = await seal(
			this.io.keys,
			this.io.rebuild(),
			`doc:${target}`,
		);
		if (!this.io.online()) return resolve("busy");
		this.settle = resolve;
		this.io.send({ type: EFrame.Rotate, target, upto, note, payload });
	}
}
