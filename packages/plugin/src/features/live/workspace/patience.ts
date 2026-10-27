/** A room answers in well under a second: past this it may never. */
const JOIN_PATIENCE_MS = 15_000;

export type Waiting = "joining" | "unanswered";

/** "unanswered" once a room asked at `subscribedAt` has been silent past the time it takes to answer. */
export function waitingSince(subscribedAt: number): Waiting {
	return Date.now() - subscribedAt < JOIN_PATIENCE_MS
		? "joining"
		: "unanswered";
}

/** A joining room turns "unanswered" with no event of its own: this wakes at the first deadline. */
export class JoinPatience {
	private timer: number | null = null;

	constructor(private readonly runOut: () => void) {}

	/** From when each joining room asked; re-armed on every call, as `runOut` should. */
	arm(subscribedAt: readonly number[]): void {
		this.stop();
		if (subscribedAt.length === 0) return;
		this.timer = window.setTimeout(
			() => {
				this.timer = null;
				this.runOut();
			},
			Math.min(...subscribedAt) + JOIN_PATIENCE_MS - Date.now(),
		);
	}

	stop(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}
}
