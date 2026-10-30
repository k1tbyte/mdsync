import { Device, disabled } from "@tests/helpers/config-device";
import { RevalidatingStorage } from "@tests/helpers/revalidating-storage";
import { useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { keepBothConflictOp } from "@/features/sync/operations/resolve";

useEncryptionKey();
const data = ".obsidian/plugins/sample/data.json";
const code = ".obsidian/plugins/sample/main.js";

async function pair() {
	const storage = new RevalidatingStorage();
	const a = new Device("a", storage);
	const b = new Device("b", storage);
	for (const device of [a, b]) {
		device.settingsSync = { ...disabled, pluginConfigs: true };
	}
	a.adapter.putText(data, '{"a":1}');
	a.adapter.putText(code, "v1");
	await a.push();
	return { a, b };
}

const remoteEntry = async (device: Device, path: string) =>
	(await device.compare()).remote?.files[path];

describe("plugin settings without their code", () => {
	it("pulls only data.json and never publishes this device's code", async () => {
		const { a, b } = await pair();
		b.pluginCode = false;
		await b.pull();
		expect(b.text(data)).toBe('{"a":1}');
		expect(b.adapter.hasFile(code)).toBe(false);

		const published = await remoteEntry(a, code);
		b.adapter.putText(code, "a local build");
		b.adapter.putText(data, '{"a":2}');
		await b.push();
		expect(await remoteEntry(a, code)).toEqual(published);

		await a.pull();
		expect(a.text(data)).toBe('{"a":2}');
		expect(a.text(code)).toBe("v1");
	});

	it("leaves code synced before frozen: no update pulled, no deletion published", async () => {
		const { a, b } = await pair();
		await b.pull();
		expect(b.text(code)).toBe("v1");
		b.pluginCode = false;

		a.adapter.putText(code, "v2");
		await a.push();
		const published = await remoteEntry(a, code);
		expect((await b.compare()).diff.remoteChanges).toEqual([]);

		await b.adapter.remove(code);
		b.adapter.putText(data, '{"a":3}');
		const result = await b.compare();
		expect(result.diff.localChanges.map((change) => change.path)).toEqual([
			data,
		]);
		await b.push();
		expect(await remoteEntry(a, code)).toEqual(published);
		expect(b.text(data)).toBe('{"a":3}');
	});

	it("refuses Keep both when the copy beside data.json would not sync", async () => {
		const { a, b } = await pair();
		b.pluginCode = false;
		await b.pull();
		a.adapter.putText(data, '{"a":"there"}');
		await a.push();
		b.adapter.putText(data, '{"a":"here"}');
		const result = await b.compare();
		const published = await remoteEntry(a, data);

		await expect(
			keepBothConflictOp(b.deps(), result, data, b.context()),
		).rejects.toThrow("would not sync");
		const copies = (await b.adapter.list(".obsidian/plugins/sample")).files;
		expect(copies).toEqual([data]);
		expect(await remoteEntry(a, data)).toEqual(published);
	});
});
