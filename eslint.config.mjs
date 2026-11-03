import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// The community scanner's ruleset, over what it scans: every .ts and .js but tests, scripts, docs and builds.
export default defineConfig([
	globalIgnores([
		"**/node_modules/",
		"**/dist/",
		"**/*.mjs",
		"**/*.cjs",
		"**/vite*",
		"**/tests/",
		"**/*.test.*",
		"**/scripts/",
		"**/docs/",
		"**/main.js",
		"artifacts/",
		"temp/",
	]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		// The scanner turns these off.
		rules: {
			"no-undef": "off",
			"@typescript-eslint/no-base-to-string": "off",
			"obsidianmd/ui/sentence-case": "off",
		},
	},
	// Accepted, still on the scanner's report: the relay is a worker and the viewer a web page, neither has
	// Obsidian's requestUrl or createEl; keyCode 229 is the only IME composition signal on Safari; slices
	// augment the empty MdsyncSettings, which a type alias cannot be.
	{
		files: ["packages/relay/src/google-oauth.ts"],
		rules: { "no-restricted-globals": "off" },
	},
	{
		files: ["packages/viewer/src/dom.ts"],
		rules: { "obsidianmd/prefer-create-el": "off" },
	},
	{
		files: ["packages/plugin/src/core/ui/input/enter-key.ts"],
		rules: { "@typescript-eslint/no-deprecated": "off" },
	},
	{
		files: ["packages/plugin/src/core/settings/model.ts"],
		rules: { "@typescript-eslint/no-empty-object-type": "off" },
	},
]);
