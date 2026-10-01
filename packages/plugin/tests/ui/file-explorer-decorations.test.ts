import { ALEX, SAM } from "@tests/helpers/explorer-host";
import { describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/plugin/host";
import {
	type PathDecoration,
	renderDecoration,
	sameDecoration,
} from "@/ui/explorer/file-explorer-decorations";
import type { ShareMark } from "@/ui/explorer/file-explorer-marks";

const SHARE: ShareMark = { root: "Team", kind: "owned", here: 1 };

describe("comparing decorations", () => {
	const full: PathDecoration = {
		change: "obsync-changed-added",
		linkRoot: "Team/link",
		ignored: true,
		skipped: "Not synced",
		unseen: { count: 1, file: "Team/a.md" },
		share: SHARE,
		people: [ALEX],
	};
	const differing: [string, PathDecoration][] = [
		["a changed status", { ...full, change: "obsync-changed-deleted" }],
		["another link", { ...full, linkRoot: "Team/other" }],
		["a lost ignore mark", { ...full, ignored: undefined }],
		["another skip reason", { ...full, skipped: "Not synced either" }],
		["another unseen count", { ...full, unseen: { count: 2 } }],
		["an unseen folder", { ...full, unseen: { count: 1 } }],
		[
			"a share of another kind",
			{ ...full, share: { ...SHARE, kind: "paused" } },
		],
		["a share with another count", { ...full, share: { ...SHARE, here: 2 } }],
		[
			"a share at another root",
			{ ...full, share: { ...SHARE, root: "Other" } },
		],
		["a dropped share", { ...full, share: undefined }],
		["a person gone idle", { ...full, people: [{ ...ALEX, idle: true }] }],
		["a renamed person", { ...full, people: [{ ...ALEX, name: "Al" }] }],
		[
			"a person at another note",
			{ ...full, people: [{ ...ALEX, note: "Team/z.md" }] },
		],
		["another person joining", { ...full, people: [ALEX, SAM] }],
		["everyone gone", { ...full, people: undefined }],
	];

	it.each(differing)("tells apart %s", (_, other) => {
		expect(sameDecoration(full, other)).toBe(false);
		expect(sameDecoration(other, full)).toBe(false);
	});

	it("takes copies as equal, an empty list as no list", () => {
		const copy: PathDecoration = {
			...full,
			share: { ...SHARE },
			unseen: { count: 1, file: "Team/a.md" },
			people: [{ ...ALEX }],
		};

		expect(sameDecoration(full, copy)).toBe(true);
		expect(sameDecoration({}, { people: [] })).toBe(true);
		expect(sameDecoration({ people: [ALEX] }, { people: [] })).toBe(false);
	});

	it("marks a row with a badge for people only when there are some", () => {
		const addClass = vi.fn();
		const target = { addClass } as unknown as HTMLElement;
		const plugin = {} as PluginHost;

		renderDecoration(target, { people: [] }, plugin);
		expect(addClass).not.toHaveBeenCalled();

		renderDecoration(target, { ignored: true }, plugin);
		expect(addClass).toHaveBeenCalledWith("obsync-explorer-ignored");
		expect(addClass).not.toHaveBeenCalledWith("obsync-has-path-badge");
	});
});
