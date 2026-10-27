import type { DataAdapter } from "obsidian";
import { carryHashes, type HashMove } from "../session-state";
import { loadState, resetState, saveState, serializeState } from "../state";
import type { LocalState } from "../types";

const PERSIST_STATE_DEBOUNCE_MS = 500;
// Obsidian awaits each rename of a burst, so only a timer batches them into one cache copy.
const HASH_CARRY_MS = 75;

export class StatePersister {
	private pendingHashCacheState: LocalState | null = null;
	private flushTimer: number | null = null;
	/**
	 * Digest of the last write, to skip rewriting identical state (3.3 MB at 20k files); a digest, not the
	 * payload, to avoid pinning it.
	 */
	private lastWritten: string | null = null;
	/** Serialises writes so an older state cannot land last. */
	private writes: Promise<void> = Promise.resolve();
	/** Unloaded: an operation still running must not write over the next instance's state. */
	private disposed = false;
	/** Renames not yet carried into the hash cache: applied before anyone reads the state. */
	private moves: HashMove[] = [];
	private carryTimer: number | null = null;

	constructor(
		private readonly adapter: DataAdapter,
		private readonly configDir: string,
		private current: LocalState,
	) {}

	/** Loading can mint a device id, which must reach disk before anything syncs. */
	static async load(
		adapter: DataAdapter,
		configDir: string,
	): Promise<StatePersister> {
		const { state, stored, clean } = await loadState(adapter, configDir);
		const persister = new StatePersister(adapter, configDir, state);
		if (stored !== null) persister.lastWritten = fingerprint(stored);
		// An unwritable disk must not stop the plugin loading; the next persist retries.
		if (!clean) await persister.write(state).catch(() => undefined);
		return persister;
	}

	get state(): LocalState {
		this.carryMoves();
		return this.current;
	}

	/** A rename keeps content, so its hashes go with it and no scan reads it again. */
	carry(move: HashMove): void {
		this.moves.push(move);
		this.carryTimer ??= window.setTimeout(
			() => this.carryMoves(),
			HASH_CARRY_MS,
		);
	}

	async persist(state: LocalState): Promise<void> {
		if (this.disposed) return;
		const prev = this.current;
		this.current = state;
		if (canDebounce(prev, state)) {
			// The scanner reuses hit entries, so an idle refresh only rebuilds an identical cache; an unknown disk still retries.
			if (
				this.lastWritten !== null &&
				sameEntries(prev?.hashCache, state.hashCache)
			) {
				return;
			}
			this.schedule(state);
			return;
		}
		this.cancelTimer();
		await this.write(state);
	}

	private write(state: LocalState): Promise<void> {
		return this.enqueue(async () => {
			const serialized = serializeState(state);
			const digest = fingerprint(serialized);
			if (digest === this.lastWritten) return;
			// writeAtomic can fail after moving the old file aside; keeping the memo would skip retrying that state.
			this.lastWritten = null;
			await saveState(this.adapter, this.configDir, serialized);
			this.lastWritten = digest;
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.writes.then(task);
		// The chain must survive a failed write, or every later one is skipped.
		this.writes = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Call while the app is still alive (visibilitychange, beforeunload): losing the pending hash cache
	 * forces a full re-hash next launch.
	 */
	async flush(): Promise<void> {
		this.carryMoves();
		const pending = this.takePending();
		if (pending) await this.write(pending);
		else await this.writes;
	}

	async reset(): Promise<LocalState> {
		this.cancelTimer();
		this.dropMoves();
		// Takes its turn in the chain rather than racing an in-flight persist.
		this.lastWritten = null;
		const next = await this.enqueue(() =>
			resetState(this.adapter, this.configDir, this.current),
		);
		this.current = next;
		this.lastWritten = fingerprint(serializeState(next));
		return next;
	}

	/** Last-ditch write from synchronous `onunload`: deliberately detached, but never unhandled. */
	dispose(): void {
		this.carryMoves();
		this.disposed = true;
		const pending = this.takePending();
		if (pending) {
			this.write(pending).catch(() => undefined);
		}
	}

	private carryMoves(): void {
		if (this.moves.length === 0) return;
		const next = carryHashes(this.current, this.moves);
		this.dropMoves();
		if (next !== this.current) void this.persist(next);
	}

	private dropMoves(): void {
		if (this.carryTimer !== null) window.clearTimeout(this.carryTimer);
		this.carryTimer = null;
		this.moves = [];
	}

	private takePending(): LocalState | null {
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		const pending = this.pendingHashCacheState;
		this.pendingHashCacheState = null;
		return pending;
	}

	private schedule(state: LocalState): void {
		this.pendingHashCacheState = state;
		if (this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			const pending = this.pendingHashCacheState;
			this.pendingHashCacheState = null;
			if (!pending) return;
			this.write(pending).catch(() => undefined);
		}, PERSIST_STATE_DEBOUNCE_MS);
	}

	private cancelTimer(): void {
		if (this.flushTimer === null) return;
		window.clearTimeout(this.flushTimer);
		this.flushTimer = null;
		this.pendingHashCacheState = null;
	}
}

function canDebounce(prev: LocalState | null, next: LocalState): boolean {
	if (!prev) return false;
	if (prev.deviceId !== next.deviceId) return false;
	if (prev.deviceName !== next.deviceName) return false;
	if (!storagesEqual(prev.storages, next.storages)) return false;
	// The first hash-cache population is the most expensive thing to lose, so it is never debounced.
	if (!hasHashCacheEntries(prev) && hasHashCacheEntries(next)) return false;
	return true;
}

/** The controller patches `storages` immutably, so per-slot reference equality detects vaultId/baseline moves. */
function storagesEqual(
	prev: LocalState["storages"],
	next: LocalState["storages"],
): boolean {
	if (prev === next) return true;
	const prevKeys = Object.keys(prev);
	const nextKeys = Object.keys(next);
	if (prevKeys.length !== nextKeys.length) return false;
	for (const key of prevKeys) {
		const p = prev[key];
		const n = next[key];
		if (!p || !n) return false;
		if (p.vaultId !== n.vaultId) return false;
		if (p.baseline !== n.baseline) return false;
		if (p.root !== n.root || p.space !== n.space) return false;
		if (!sameEntries(p.shareBases, n.shareBases)) return false;
	}
	return true;
}

/** Same keys holding the same objects: a rebuilt map of unchanged entries needs no serializing to compare. */
function sameEntries(
	prev: Readonly<Record<string, unknown>> = {},
	next: Readonly<Record<string, unknown>> = {},
): boolean {
	if (prev === next) return true;
	const keys = Object.keys(prev);
	if (keys.length !== Object.keys(next).length) return false;
	return keys.every(
		(key) => Object.hasOwn(next, key) && prev[key] === next[key],
	);
}

function hasHashCacheEntries(state: LocalState): boolean {
	return Object.keys(state.hashCache ?? {}).length > 0;
}

/** Two FNV-1a passes plus length: one 32-bit pass collides often enough on megabyte payloads to skip a needed write. */
function fingerprint(text: string): string {
	let a = 0x811c9dc5;
	let b = 0xcbf29ce4;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		a = Math.imul(a ^ code, 0x01000193);
		b = Math.imul(b ^ code, 0x85ebca6b);
	}
	return `${text.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}
