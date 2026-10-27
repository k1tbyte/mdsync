import { describe, expect, it } from "vitest";
import { MANIFEST_VERSION } from "@/features/sync/constants";
import { defaultDeviceName } from "@/features/sync/identity/device";
import { buildManifest } from "@/features/sync/remote/manifest";

const snapshot = {
	files: {},
	emptyFolders: [],
};

describe("buildManifest deviceName", () => {
	it("keeps an explicit device name", () => {
		const m = buildManifest("dev1", "Windows desktop", "v", null, snapshot);
		expect(m.deviceName).toBe("Windows desktop");
	});

	it("defaults undefined to defaultDeviceName()", () => {
		const m = buildManifest("dev1", undefined, "v", null, snapshot);
		expect(m.deviceName).toBe(defaultDeviceName());
		expect(m.deviceName).toBeTruthy();
	});

	it("defaults a blank/whitespace name to defaultDeviceName()", () => {
		const m = buildManifest("dev1", "   ", "v", null, snapshot);
		expect(m.deviceName).toBe(defaultDeviceName());
	});
});

describe("buildManifest version", () => {
	it("publishes MANIFEST_VERSION over an older parent, so 1.x clients refuse it", () => {
		const parent = buildManifest("dev1", "d", "v", null, snapshot);
		const m = buildManifest(
			"dev1",
			"d",
			"v",
			{ ...parent, version: 2 },
			snapshot,
		);
		expect(m.version).toBe(MANIFEST_VERSION);
	});
});
