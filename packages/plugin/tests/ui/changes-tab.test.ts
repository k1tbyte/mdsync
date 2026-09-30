import { FakeEl } from "@tests/helpers/fake-obsidian-dom";
import { describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/plugin/host";
import type { SyncStatusSnapshot } from "@/sync/controller";
import type { SourceControlActions } from "@/ui/source-control/actions";
import { ChangesTab } from "@/ui/source-control/changes-tab";
import type { ConflictPreviewManager } from "@/ui/source-control/conflict-preview-manager";

vi.mock("obsidian", async (importOriginal) =>
	(await import("@tests/helpers/fake-obsidian-dom")).fakeObsidian(
		await importOriginal(),
	),
);

const noChanges = {
	conflicts: [],
	localChanges: [],
	remoteChanges: [],
};

function snapshot(
	diff: object | null,
	overrides: Partial<SyncStatusSnapshot> = {},
): SyncStatusSnapshot {
	return {
		busy: false,
		error: null,
		spaceErrors: [],
		staleReason: null,
		lastCompareAt: Date.now(),
		conflicts: 0,
		pendingLocal: 0,
		pendingRemote: 0,
		result: diff && {
			diff,
			snapshot: { files: {}, ignoredPaths: [] },
			remote: { files: {} },
		},
		...overrides,
	} as unknown as SyncStatusSnapshot;
}

function tab(actions: Partial<SourceControlActions> = {}): ChangesTab {
	const plugin = {
		settings: { uiLayout: "tree", showFileSizes: false },
		controller: { getSnapshot: () => snapshot(null) },
		spaces: { partition: () => [] },
	} as unknown as PluginHost;
	return new ChangesTab(
		plugin,
		{
			prune: vi.fn(),
			clearCache: vi.fn(),
			isExpanded: () => false,
		} as unknown as ConflictPreviewManager,
		actions as SourceControlActions,
		vi.fn(),
		vi.fn(),
	);
}

const empties = (root: FakeEl): string[] =>
	root.find((el) => el.hasClass("is-empty")).map((el) => el.text);

function rendered(
	diff: object | null,
	options: {
		filter?: string;
		snapshot?: Partial<SyncStatusSnapshot>;
		actions?: Partial<SourceControlActions>;
	} = {},
): FakeEl {
	const root = new FakeEl("div");
	const changes = tab(options.actions);
	(changes as unknown as { filter: string }).filter = options.filter ?? "";
	changes.render(root as never, snapshot(diff, options.snapshot));
	return root;
}

describe("ChangesTab empty state", () => {
	it("says so when the compare found nothing to push or pull", () => {
		expect(empties(rendered(noChanges))).toEqual(["No changes."]);
	});

	it("asks for a compare before the first one", () => {
		expect(empties(rendered(null))).toEqual(["Run compare to see changes."]);
	});

	it("names the filter when it hides every row", () => {
		const diff = { ...noChanges, conflicts: [{ path: "a.md" }] };
		expect(empties(rendered(diff, { filter: "zzz" }))).toEqual([
			"No changed files match the filter.",
		]);
	});

	it("reads a whitespace-only filter as no filter", () => {
		expect(empties(rendered(noChanges, { filter: "   " }))).toEqual([
			"No changes.",
		]);
		const diff = {
			...noChanges,
			localChanges: [{ path: "a.md", type: "add" }],
		};
		expect(empties(rendered(diff, { filter: "   " }))).toEqual([]);
	});

	it("stays quiet under an error", () => {
		const root = rendered(noChanges, { snapshot: { error: "Network down" } });
		expect(empties(root)).toEqual([]);
		expect(root.textContent).toContain("Error: Network down");
	});

	it("stays quiet under a share error", () => {
		const spaceErrors = [{ root: "Team", message: "Folder is missing" }];
		const root = rendered(noChanges, { snapshot: { spaceErrors } });
		expect(empties(root)).toEqual([]);
		expect(root.textContent).toContain('Error in "Team": Folder is missing');
	});
});

const buttons = (root: FakeEl): FakeEl[] =>
	root.find((el) => el.tag === "button");

const named = (root: FakeEl, text: string): FakeEl =>
	buttons(root).find((el) => el.textContent.startsWith(text)) as FakeEl;

const everything = {
	conflicts: [{ path: "c.md" }],
	localChanges: [{ path: "l.md", type: "local-add" }],
	remoteChanges: [{ path: "r.md", type: "remote-add" }],
};

describe("ChangesTab action buttons", () => {
	it("builds warning and call-to-action buttons with Obsidian's own styles", () => {
		const root = rendered(everything, { snapshot: { cancellable: true } });
		for (const text of ["Cancel", "Keep all local", "Accept all remote"]) {
			expect(named(root, text).hasClass("mod-warning")).toBe(true);
		}
		expect(named(root, "Revert selected").hasClass("mod-warning")).toBe(true);
		for (const text of ["Push", "Pull", "Push selected", "Pull selected"]) {
			expect(named(root, text).hasClass("mod-cta")).toBe(true);
		}
	});

	it("leaves no custom colour classes on any button", () => {
		const root = rendered(everything, { snapshot: { cancellable: true } });
		const custom = buttons(root).filter(
			(el) => el.hasClass("is-warning") || el.hasClass("is-primary"),
		);
		expect(custom).toEqual([]);
	});

	it("keeps the bulk buttons' own layout class", () => {
		const root = rendered(everything);
		expect(named(root, "Push").hasClass("obsync-bulk-action")).toBe(true);
		expect(named(root, "Pull").hasClass("obsync-bulk-action")).toBe(true);
	});

	it("disables the conflict shortcuts while a sync runs", () => {
		const root = rendered(everything, { snapshot: { busy: true } });
		expect(named(root, "Keep all local").disabled).toBe(true);
		expect(named(root, "Accept all remote").disabled).toBe(true);
	});

	it("offers to resolve a vault mismatch as a warning button", () => {
		const adoptNewVault = vi.fn();
		const root = rendered(noChanges, {
			snapshot: { error: "Remote vault id does not match local" },
			actions: { adoptNewVault },
		});
		const resolve = named(root, "Resolve vault mismatch");
		expect(resolve.hasClass("mod-warning")).toBe(true);
		resolve.fire("click");
		expect(adoptNewVault).toHaveBeenCalledOnce();
	});

	it("offers no resolve button for any other error", () => {
		const root = rendered(noChanges, {
			snapshot: { error: "Network down" },
		});
		expect(named(root, "Resolve vault mismatch")).toBeUndefined();
	});
});
