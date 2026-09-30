import { describe, expect, it, vi } from "vitest";

import { baseTextOf } from "@/plugin/live";
import { type Space, VAULT_SPACE } from "@/sync/space";

const TEAM: Space = { id: "team", root: "Team" };

/** Baselines by space id, then path; `remote` is what the share's last compare saw. */
function hostWith(
	baselines: Record<string, Record<string, string>>,
	remote: boolean | null = null,
) {
	const loadBaselineForPath = vi.fn(async (path: string, space?: Space) => {
		const id = space?.id ?? (path.startsWith("Team/") ? TEAM.id : "vault");
		const text = baselines[id]?.[path];
		return text === undefined ? null : { hash: "h", text };
	});
	const host = {
		controller: { fileDiffs: { loadBaselineForPath }, remoteHas: () => remote },
		spaces: { partition: () => [VAULT_SPACE, TEAM] },
	} as unknown as Parameters<typeof baseTextOf>[0];
	return { host, loadBaselineForPath };
}

describe("a live note's cold merge base", () => {
	it("is its own space's baseline", async () => {
		const { host } = hostWith({
			team: { "Team/a.md": "shared" },
			vault: { "Team/a.md": "frozen" },
		});

		expect(await baseTextOf(host, "Team/a.md")).toBe("shared");
	});

	it("falls back to the vault's frozen entry for a note that just became a share", async () => {
		expect(
			await baseTextOf(
				hostWith({ vault: { "Team/a.md": "frozen" } }).host,
				"Team/a.md",
			),
		).toBe("frozen");
		expect(
			await baseTextOf(
				hostWith({ vault: { "Team/a.md": "frozen" } }, true).host,
				"Team/a.md",
			),
		).toBe("frozen");
	});

	it("is none for a note the share compared without, deleted or new there", async () => {
		const { host, loadBaselineForPath } = hostWith(
			{ vault: { "Team/a.md": "frozen" } },
			false,
		);

		expect(await baseTextOf(host, "Team/a.md")).toBeNull();
		expect(loadBaselineForPath).toHaveBeenCalledTimes(1);
	});

	it("is none for a vault note never synced, asked once", async () => {
		const { host, loadBaselineForPath } = hostWith({});

		expect(await baseTextOf(host, "a.md")).toBeNull();
		expect(loadBaselineForPath).toHaveBeenCalledTimes(1);
	});
});
