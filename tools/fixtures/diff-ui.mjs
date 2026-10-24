import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The plugin's own hunks, so the fixture shows exactly what Push and Revert move.
const jiti = createJiti(import.meta.url, {
	alias: {
		"@": fileURLToPath(new URL("../../packages/plugin/src", import.meta.url)),
	},
});
const { computeHunks } = await jiti.import(
	"../../packages/plugin/src/sync/hunks.ts",
);

// Synthetic models exercise the real renderer; controller calls are captured, never sent.
export const base = [
	"# Diff and merge preview",
	"",
	"First original paragraph.",
	"Shared separator.",
	"Second original paragraph.",
	"",
	...Array.from(
		{ length: 45 },
		(_, i) => `Context ${i + 1}: ${"unchanged text ".repeat(8)}`,
	),
	"",
	"Last original paragraph.",
	"Delete this line remotely.",
].join("\n");
export const local = base
	.replace(
		"First original paragraph.",
		"First local paragraph.\nAnother local line.",
	)
	.replace("Second original paragraph.", "Second local paragraph.")
	.replace("Last original paragraph.", "Last local paragraph.");
export const remote = base
	.replace("First original paragraph.", "First remote paragraph.")
	.replace(
		"Second original paragraph.",
		"Second remote paragraph.\nAnother remote line.",
	)
	.replace("Last original paragraph.", "Last remote paragraph.")
	.replace("\nDelete this line remotely.", "");

export function model(leftText = base, rightText = local, direction = "local") {
	return {
		path: "Diff UI verification.md",
		direction,
		changeType: "modified",
		leftText,
		rightText,
		leftHash: leftText,
		rightHash: rightText,
		leftLabel: direction === "local" ? "Baseline" : "Local",
		rightLabel: direction === "local" ? "Local" : "Remote",
		leftPresent: true,
		rightPresent: true,
		leftSize: leftText.length,
		rightSize: rightText.length,
		isBinary: false,
		forceTextAvailable: false,
		hunks: {
			leftLines: leftText.split("\n"),
			rightLines: rightText.split("\n"),
			hunks: computeHunks(leftText, rightText).hunks,
		},
	};
}
