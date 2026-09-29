import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import type { DataAdapter } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { AgreedTexts } from "@/live/agreed-texts";

const DIR = ".obsidian/plugins/obsync/live";

function store(adapter: InMemoryAdapter): AgreedTexts {
	return new AgreedTexts(adapter as unknown as DataAdapter, ".obsidian");
}

describe("agreed texts", () => {
	it("answers from memory before the write and from disk after it", async () => {
		const adapter = new InMemoryAdapter();
		const agreed = store(adapter);

		agreed.put("doc", { text: "hello", gen: 0, seq: 3 });
		expect(await agreed.get("doc")).toEqual({ text: "hello", gen: 0, seq: 3 });

		await agreed.flush();
		expect(await store(adapter).get("doc")).toEqual({
			text: "hello",
			gen: 0,
			seq: 3,
		});
	});

	it("answers the latest agreement while an older one is being written", async () => {
		const agreed = store(new InMemoryAdapter());
		agreed.put("doc", { text: "old", gen: 0, seq: 1 });

		const flushing = agreed.flush();
		expect(await agreed.get("doc")).toEqual({ text: "old", gen: 0, seq: 1 });
		agreed.put("doc", { text: "new", gen: 0, seq: 2 });
		await flushing;

		expect(await agreed.get("doc")).toEqual({ text: "new", gen: 0, seq: 2 });
		await agreed.flush();
	});

	it("treats a torn file as no base at all", async () => {
		const adapter = new InMemoryAdapter();
		adapter.putText(`${DIR}/doc.json`, '{"text": "cut');

		expect(await store(adapter).get("doc")).toBeNull();
		expect(await store(adapter).get("missing")).toBeNull();
	});

	it("lists again after a listing failed", async () => {
		const adapter = new InMemoryAdapter();
		adapter.putText(`${DIR}/doc.json`, '{"text":"a","gen":0,"seq":1}');
		vi.spyOn(adapter, "list").mockRejectedValueOnce(new Error("busy"));
		const agreed = store(adapter);

		expect(await agreed.get("doc")).toBeNull();
		expect(await agreed.get("doc")).toEqual({ text: "a", gen: 0, seq: 1 });
	});

	it("keeps only the most recently agreed documents", async () => {
		const adapter = new InMemoryAdapter();
		for (let i = 0; i < 502; i++) {
			adapter.putText(`${DIR}/doc-${i}.json`, '{"text":"","gen":0,"seq":0}');
		}

		await store(adapter).prune();

		const { files } = await adapter.list(DIR);
		expect(files).toHaveLength(500);
		expect(files).not.toContain(`${DIR}/doc-0.json`);
		expect(files).not.toContain(`${DIR}/doc-1.json`);
	});
});
