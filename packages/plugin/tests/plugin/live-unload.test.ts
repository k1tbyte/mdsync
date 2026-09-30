import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveLiveKeys } from "@/crypto/live-keys";
import type { HubConnection } from "@/hub/connection";
import { AgreedTexts } from "@/live/agreed-texts";
import { docIdIn } from "@/live/space";
import { createLive, type LiveHost } from "@/plugin/live";
import { VAULT_SPACE } from "@/sync/space";

const LIVE_DIR = ".obsidian/plugins/obsync/live";

let hideDocument: () => void;
let closeWindow: () => void;

beforeEach(() => {
	const documentEvents = new EventTarget();
	const windowEvents = new EventTarget();
	const shown = { visibilityState: "visible" };
	vi.stubGlobal("document", {
		get visibilityState() {
			return shown.visibilityState;
		},
		addEventListener: documentEvents.addEventListener.bind(documentEvents),
		removeEventListener:
			documentEvents.removeEventListener.bind(documentEvents),
	});
	vi.stubGlobal(
		"addEventListener",
		windowEvents.addEventListener.bind(windowEvents),
	);
	vi.stubGlobal(
		"removeEventListener",
		windowEvents.removeEventListener.bind(windowEvents),
	);
	hideDocument = () => {
		shown.visibilityState = "hidden";
		documentEvents.dispatchEvent(new Event("visibilitychange"));
	};
	closeWindow = () => windowEvents.dispatchEvent(new Event("beforeunload"));
});

afterEach(() => vi.unstubAllGlobals());

async function agreedOn(adapter: InMemoryAdapter) {
	const keys = await deriveLiveKeys(crypto.getRandomValues(new Uint8Array(32)));
	const noop = () => ({});
	const host = {
		app: {
			workspace: { on: noop, offref: noop, onLayoutReady: noop },
			vault: { adapter, configDir: ".obsidian", on: noop, offref: noop },
			metadataCache: { on: noop, offref: noop },
		},
		settings: () => ({ liveEditing: true, showLiveAuthors: false }),
		partition: () => [VAULT_SPACE],
	} as unknown as LiveHost;
	const hub = { listen: () => () => {} } as unknown as HubConnection;
	const live = createLive(
		host,
		hub,
		async () => ({ keys, person: "owner", key: "d1", name: "Laptop" }),
		() => null,
	);
	const doc = await docIdIn({ keys, root: "" }, "a.md", 0);
	await live
		.notes(VAULT_SPACE)
		.wrote("a.md", { doc, gen: 1, seq: 4 }, "typed\r\n");
	return { live, path: `${LIVE_DIR}/${doc}.json` };
}

function stored(adapter: InMemoryAdapter, path: string): unknown {
	return JSON.parse(adapter.readText(path));
}

describe("live editing's agreed texts when the app goes away", () => {
	it("are written the moment the plugin unloads", async () => {
		const adapter = new InMemoryAdapter();
		const { live, path } = await agreedOn(adapter);
		expect(adapter.hasFile(path)).toBe(false);

		live.dispose();

		await vi.waitFor(() => expect(adapter.hasFile(path)).toBe(true));
		expect(stored(adapter, path)).toEqual({ text: "typed\n", gen: 1, seq: 4 });
	});

	it("are written when the window is hidden, without waiting for the delay", async () => {
		const adapter = new InMemoryAdapter();
		const { live, path } = await agreedOn(adapter);

		hideDocument();

		await vi.waitFor(() => expect(adapter.hasFile(path)).toBe(true));
		live.dispose();
	});

	it("are written as the window unloads", async () => {
		const adapter = new InMemoryAdapter();
		const { live, path } = await agreedOn(adapter);

		closeWindow();

		await vi.waitFor(() => expect(adapter.hasFile(path)).toBe(true));
		live.dispose();
	});

	it("stop being flushed by the window once the plugin is unloaded", async () => {
		const { live } = await agreedOn(new InMemoryAdapter());
		live.dispose();
		const flush = vi.spyOn(AgreedTexts.prototype, "flush");

		hideDocument();
		closeWindow();

		expect(flush).not.toHaveBeenCalled();
	});
});
