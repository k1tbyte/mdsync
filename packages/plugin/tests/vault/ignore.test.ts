import type { DataAdapter } from "obsidian";
import { describe, expect, it } from "vitest";
import { VAULT_SPACE } from "@/sync/space";
import {
	createIgnoreMatcher,
	ignoreHome,
	isIgnoreNote,
	loadSharedIgnoreMatcher,
} from "@/vault/ignore";

describe("ignore matcher loading", () => {
	it("loads local ignore patterns from settings only", async () => {
		const matcher = createIgnoreMatcher("*.jpg\nnode_modules/");

		expect(matcher.ignores("photo.jpg")).toBe(true);
		expect(matcher.ignores("folder/photo.jpg")).toBe(true);
		expect(matcher.ignores("node_modules/package.json")).toBe(true);
		expect(matcher.ignores("script.ts")).toBe(false);
	});

	it("strips leading slashes before matching", async () => {
		const matcher = createIgnoreMatcher("root-file.txt");
		expect(matcher.ignores("/root-file.txt")).toBe(true);
	});

	it("parses the shared ignore file effectively", async () => {
		const mockAdapter = {
			exists: async () => true,
			read: async () => "# ignore this\n\n\nsecret.key",
		} as unknown as DataAdapter;

		const matcher = await loadSharedIgnoreMatcher(mockAdapter);
		expect(matcher.ignores("secret.key")).toBe(true);
		expect(matcher.ignores("public.key")).toBe(false);
	});

	it("returns pass-through if no local patterns", async () => {
		const matcher = createIgnoreMatcher("");
		expect(matcher.ignores("any-file.txt")).toBe(false);
	});

	it("loads shared rules from syncignore.md", async () => {
		const mockAdapter = createIgnoreAdapter({
			syncignore: "*.pdf\nassets/",
		});

		const matcher = await loadSharedIgnoreMatcher(
			mockAdapter as unknown as DataAdapter,
		);
		expect(matcher.ignores("paper.pdf")).toBe(true);
		expect(matcher.ignores("assets/icon.svg")).toBe(true);
		expect(matcher.ignores("note.md")).toBe(false);
	});
});

function createIgnoreAdapter(input: { syncignore?: string }) {
	return {
		exists: async (path: string) => {
			if (path === "syncignore.md") return input.syncignore !== undefined;
			return false;
		},
		read: async (path: string) => {
			if (path === "syncignore.md") return input.syncignore ?? "";
			return "";
		},
	};
}

describe("ignore rules per space", () => {
	const spaces = [VAULT_SPACE, { id: "a", root: "Team" }];

	it("read a share's rules inside its root only", () => {
		const matcher = createIgnoreMatcher("/drafts/\nsecret.md", "Team");

		expect(matcher.ignores("Team/drafts/x.md")).toBe(true);
		expect(matcher.ignores("Team/deep/secret.md")).toBe(true);
		expect(matcher.ignores("drafts/x.md")).toBe(false);
		expect(matcher.ignores("Teams/secret.md")).toBe(false);
		expect(matcher.ignores("Team")).toBe(false);
	});

	it("keep each space's note in its root", () => {
		expect(ignoreHome(spaces, "Team/drafts")).toEqual({
			note: "Team/syncignore.md",
			inside: "drafts",
		});
		expect(ignoreHome(spaces, "notes/a.md").note).toBe("syncignore.md");
		expect(isIgnoreNote(spaces, "Team/syncignore.md")).toBe(true);
		expect(isIgnoreNote(spaces, "Team/sub/syncignore.md")).toBe(false);
		expect(isIgnoreNote(spaces, "syncignore.md")).toBe(true);
	});
});
