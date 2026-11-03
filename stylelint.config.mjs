// The community scanner's CSS checks; Obsidian 1.11.4 runs Chromium 142.
export default {
	plugins: ["stylelint-no-unsupported-browser-features"],
	ignoreFiles: [
		"**/node_modules/**",
		"**/dist/**",
		"**/tests/**",
		"**/docs/**",
		"artifacts/**",
		"temp/**",
		"packages/plugin/styles.css",
	],
	rules: {
		"selector-pseudo-class-disallowed-list": [
			["has"],
			{
				message:
					"Avoid :has - it can cause significant performance issues due to broad selector invalidation.",
			},
		],
		"declaration-no-important": true,
		"plugin/no-unsupported-browser-features": [
			true,
			{ browsers: ["chrome 142"] },
		],
	},
	// Accepted, still on the scanner's report: the viewer is a web page, not Obsidian; an info label menu item has
	// no class of its own; the meter row and the hidden label work in every Obsidian; CodeMirror sets flex-basis inline.
	overrides: [
		{
			files: [
				"packages/viewer/src/note/note.css",
				"packages/plugin/src/features/presence/ui/presence.css",
			],
			rules: { "selector-pseudo-class-disallowed-list": null },
		},
		{
			files: [
				"packages/plugin/src/features/setup/styles/setup-forms.css",
				"packages/plugin/src/features/setup/styles/setup-stepper.css",
			],
			rules: { "plugin/no-unsupported-browser-features": null },
		},
		{
			files: ["packages/plugin/src/features/diff/styles/pane-grid.css"],
			rules: { "declaration-no-important": null },
		},
	],
};
