import { device, record } from "@tests/helpers/space-records";
import type { Menu, MenuItem } from "obsidian";
import { describe, expect, it } from "vitest";

import type { PluginHost } from "@/plugin/host";
import type { SpaceRecord } from "@/spaces/record";
import { EStorageBackend, type S3StorageConfig } from "@/storage";
import { addShareMenuItem } from "@/ui/shares/share-window";

const S3: S3StorageConfig = {
	kind: EStorageBackend.S3,
	endpoint: "https://s3.example",
	region: "auto",
	bucket: "notes",
	prefix: "",
	accessKeyId: "id",
	secretAccessKey: "secret",
	forcePathStyle: true,
	concurrency: 4,
};

function entriesFor(
	storage: S3StorageConfig | null,
	shared: SpaceRecord[] = [],
	root = "Team",
	useSharedFolders = true,
): { title: string; disabled: boolean }[] {
	const plugin = {
		settings: {
			useSharedFolders,
			activeStorageKind: EStorageBackend.S3,
			storageConfigs: storage ? { [EStorageBackend.S3]: storage } : {},
		},
		spaces: device(shared).records,
	} as unknown as PluginHost;
	const entries: { title: string; disabled: boolean }[] = [];
	const menu = {
		addItem: (build: (item: MenuItem) => void) => {
			const entry = { title: "", disabled: false };
			const item = {
				setTitle: (title: string) => {
					entry.title = title;
					return item;
				},
				setIcon: () => item,
				setDisabled: (disabled: boolean) => {
					entry.disabled = disabled;
					return item;
				},
				onClick: () => item,
			};
			build(item as unknown as MenuItem);
			entries.push(entry);
		},
	} as unknown as Menu;
	addShareMenuItem(menu, plugin, root);
	return entries;
}

describe("the share folder entry", () => {
	it("is there to use once S3 storage is set up", () => {
		expect(entriesFor(S3)).toEqual([
			{ title: "MDSync: Share folder", disabled: false },
		]);
	});

	it("stays, disabled and saying why, without S3 storage", () => {
		expect(entriesFor(null)).toEqual([
			{ title: "MDSync: Share folder (needs S3 storage)", disabled: true },
		]);
	});

	it("opens the window of a folder already shared", () => {
		expect(entriesFor(null, [record("a", "Team")])).toEqual([
			{ title: "MDSync: Manage sharing", disabled: false },
		]);
	});

	it("opens the window of the share a subfolder is in", () => {
		expect(entriesFor(S3, [record("a", "Team")], "Team/Plans")).toEqual([
			{ title: "MDSync: Manage sharing", disabled: false },
		]);
	});

	it("offers sharing again once the share is closed", () => {
		const closed: SpaceRecord = { ...record("a", "Team"), closed: true };
		expect(entriesFor(S3, [closed])).toEqual([
			{ title: "MDSync: Share folder", disabled: false },
		]);
	});

	it("is left out where sharing is refused", () => {
		expect(entriesFor(S3, [record("a", "Team/Plans")])).toEqual([]);
		expect(entriesFor(S3, [], "Team/.hidden")).toEqual([]);
	});

	it("is left out where shared folders are off", () => {
		expect(entriesFor(S3, [], "Team", false)).toEqual([]);
		expect(entriesFor(S3, [record("a", "Team")], "Team", false)).toEqual([]);
	});
});
