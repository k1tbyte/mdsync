import { Device, disabled } from "@tests/helpers/config-device";
import { RevalidatingStorage } from "@tests/helpers/revalidating-storage";
import { useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { EPluginLevel } from "@/core/settings/model";
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
		b.pluginLevel = EPluginLevel.Settings;
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
		b.pluginLevel = EPluginLevel.Settings;

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
		b.pluginLevel = EPluginLevel.Settings;
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

describe("plugin levels per plugin", () => {
	const x = ".obsidian/plugins/x";
	const y = ".obsidian/plugins/y";
	const files = [
		`${x}/data.json`,
		`${x}/main.js`,
		`${x}/sub/a.bin`,
		`${y}/data.json`,
		`${y}/main.js`,
	];

	async function pairOfPlugins() {
		const storage = new RevalidatingStorage();
		const a = new Device("a", storage);
		const b = new Device("b", storage);
		for (const device of [a, b]) {
			device.settingsSync = { ...disabled, pluginConfigs: true };
		}
		for (const path of files) a.adapter.putText(path, `a:${path}`);
		await a.push();
		return { a, b };
	}

	it("keeps a plugin set to Off from arriving while the others do", async () => {
		const { b } = await pairOfPlugins();
		b.pluginLevels = { x: EPluginLevel.Off };
		const offered = (await b.compare()).diff.remoteChanges.map((c) => c.path);
		expect(offered.filter((path) => path.startsWith(x))).toEqual([]);
		expect(offered).toContain(`${y}/main.js`);
		await b.pull();
		for (const path of files.filter((path) => path.startsWith(x))) {
			expect(b.adapter.hasFile(path)).toBe(false);
		}
		expect(b.text(`${y}/main.js`)).toBe(`a:${y}/main.js`);
		expect(b.text(`${y}/data.json`)).toBe(`a:${y}/data.json`);
	});

	it("never publishes this device's files of a plugin set to Off", async () => {
		const { a, b } = await pairOfPlugins();
		b.pluginLevels = { x: EPluginLevel.Off };
		const published = await remoteEntry(a, `${x}/data.json`);
		b.adapter.putText(`${x}/data.json`, "b's own");
		b.adapter.putText(`${x}/local.bin`, "b only");
		b.adapter.putText(`${y}/extra.bin`, "y is still synced");
		await b.push();

		expect(await remoteEntry(a, `${x}/local.bin`)).toBeUndefined();
		expect(await remoteEntry(a, `${x}/data.json`)).toEqual(published);
		expect(await remoteEntry(a, `${y}/extra.bin`)).toBeDefined();
		await a.pull();
		expect(a.text(`${x}/data.json`)).toBe(`a:${x}/data.json`);
		expect(a.adapter.hasFile(`${x}/local.bin`)).toBe(false);
	});

	it("publishes no deletion when this device removes the folder of a plugin set to Off", async () => {
		const { a, b } = await pairOfPlugins();
		await b.pull();
		expect(b.text(`${x}/sub/a.bin`)).toBe(`a:${x}/sub/a.bin`);
		b.pluginLevels = { x: EPluginLevel.Off };
		const published = await remoteEntry(a, `${x}/main.js`);

		await b.adapter.rmdir(x, true);
		b.adapter.putText(`${y}/data.json`, "b's y");
		const result = await b.compare();
		expect(result.diff.localChanges.map((change) => change.path)).toEqual([
			`${y}/data.json`,
		]);
		await b.push();

		expect(await remoteEntry(a, `${x}/main.js`)).toEqual(published);
		await a.pull();
		for (const path of files.filter((path) => path.startsWith(x))) {
			expect(a.text(path)).toBe(`a:${path}`);
		}
		expect(a.text(`${y}/data.json`)).toBe("b's y");
	});

	it("takes just the plugins with a level while plugin configuration is off", async () => {
		const { b } = await pairOfPlugins();
		b.settingsSync = { ...disabled };
		b.pluginLevels = { x: EPluginLevel.Code };
		await b.pull();

		expect(b.text(`${x}/data.json`)).toBe(`a:${x}/data.json`);
		expect(b.text(`${x}/main.js`)).toBe(`a:${x}/main.js`);
		expect(b.adapter.hasFile(`${x}/sub/a.bin`)).toBe(false);
		expect(b.adapter.hasFile(`${y}/data.json`)).toBe(false);
		expect(b.adapter.hasFile(`${y}/main.js`)).toBe(false);
	});
});
