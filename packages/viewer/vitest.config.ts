import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "jsdom",
		// Node 25+ has a global localStorage of its own that hides jsdom's.
		execArgv: ["--no-experimental-webstorage"],
		include: ["tests/**/*.test.ts"],
	},
});
