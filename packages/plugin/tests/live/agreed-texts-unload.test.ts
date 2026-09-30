import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import type { DataAdapter } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgreedTexts } from "@/live/agreed-texts";

const PATH = ".obsidian/plugins/obsync/live/doc.json";
const WRITE_DELAY_MS = 2_000;

class HeldWrites extends InMemoryAdapter {
	held: Array<{ land: () => void }> = [];
	started = 0;
	peakInFlight = 0;

	override write(path: string, data: string): Promise<void> {
		this.started++;
		return new Promise((resolve) => {
			const entry = {
				land: () => {
					this.held = this.held.filter((other) => other !== entry);
					void super.write(path, data).then(resolve);
				},
			};
			this.held.push(entry);
			this.peakInFlight = Math.max(this.peakInFlight, this.held.length);
		});
	}

	landNewestFirst(): void {
		this.held.at(-1)?.land();
	}
}

function store(adapter: InMemoryAdapter): AgreedTexts {
	return new AgreedTexts(adapter as unknown as DataAdapter, ".obsidian");
}

function agreement(text: string, seq: number) {
	return { text, gen: 0, seq };
}

afterEach(() => vi.useRealTimers());

describe("agreed texts at unload", () => {
	it("writes what was agreed a moment ago, and only once", async () => {
		vi.useFakeTimers();
		const adapter = new HeldWrites();
		const agreed = store(adapter);
		agreed.put("doc", agreement("typed", 4));

		const unloading = agreed.flush();
		await vi.advanceTimersByTimeAsync(0);
		adapter.landNewestFirst();
		await unloading;
		await vi.advanceTimersByTimeAsync(2 * WRITE_DELAY_MS);

		expect(JSON.parse(adapter.readText(PATH))).toEqual(agreement("typed", 4));
		expect(adapter.started).toBe(1);
	});

	it("leaves the newest agreement on disk when unloaded while an older one is being written", async () => {
		vi.useFakeTimers();
		const adapter = new HeldWrites();
		const agreed = store(adapter);
		agreed.put("doc", agreement("old", 1));
		await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS);
		expect(adapter.held).toHaveLength(1);
		agreed.put("doc", agreement("new", 2));

		let unloaded = false;
		void agreed.flush().then(() => {
			unloaded = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		while (!unloaded || adapter.held.length > 0) {
			adapter.landNewestFirst();
			await vi.advanceTimersByTimeAsync(0);
		}

		expect(JSON.parse(adapter.readText(PATH))).toEqual(agreement("new", 2));
		expect(adapter.peakInFlight).toBe(1);
	});

	it("waits for the write already under way instead of repeating it", async () => {
		vi.useFakeTimers();
		const adapter = new HeldWrites();
		const agreed = store(adapter);
		agreed.put("doc", agreement("text", 1));
		await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS);
		expect(adapter.held).toHaveLength(1);

		const unloading = agreed.flush();
		await vi.advanceTimersByTimeAsync(0);
		adapter.landNewestFirst();
		await unloading;

		expect(adapter.started).toBe(1);
		expect(JSON.parse(adapter.readText(PATH))).toEqual(agreement("text", 1));
	});
});
