import { frameTask } from "@/core/ui";

export type SnapshotListener<T> = (snapshot: T) => void;

export interface StatusBroadcasterOptions<T> {
	getSnapshot: () => T;
}

export class StatusBroadcaster<T> {
	private readonly listeners = new Set<SnapshotListener<T>>();
	private readonly getSnapshot: () => T;
	private readonly frame = frameTask(() => this.emitNow());
	private disposed = false;

	constructor(options: StatusBroadcasterOptions<T>) {
		this.getSnapshot = options.getSnapshot;
	}

	subscribe(listener: SnapshotListener<T>): () => void {
		// Keeping listener after dispose would pin closures unnecessarily.
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => {
			this.listeners.delete(listener);
		};
	}

	broadcast(): void {
		this.cancelPending();
		this.emitNow();
	}

	broadcastSoon(): void {
		if (this.disposed) return;
		this.frame.schedule();
	}

	dispose(): void {
		this.disposed = true;
		this.cancelPending();
		this.listeners.clear();
	}

	private cancelPending(): void {
		this.frame.cancel();
	}

	private emitNow(): void {
		if (this.disposed) return;
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch (err) {
				console.error("[mdsync] listener failed", err);
			}
		}
	}
}
