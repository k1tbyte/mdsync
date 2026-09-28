/**
 * A throwaway Obsidian: its own user-data dir (so the user's vaults and config
 * stay out of reach) and a fresh vault running this build of the plugin,
 * driven over CDP. Run `pnpm build` first; the vault gets the built bundle.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	copyFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Page } from "playwright-core";

import { killTree, poll } from "./harness";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN_FILES = [
	"packages/plugin/main.js",
	"packages/plugin/styles.css",
	"manifest.json",
];
const EXE =
	process.env.OBSIDIAN_EXE ?? "C:\\Program Files\\Obsidian\\Obsidian.exe";
const APP_URL = "app://obsidian.md";
const TRUST_BUTTON = /trust author and enable plugins/i;

export interface Obsidian {
	vault: string;
	/** Runs in the renderer, where `app` is a global; `fn` cannot close over anything. */
	evaluate: Page["evaluate"];
	waitFor<T>(
		label: string,
		fn: () => T,
		accept: (value: T) => boolean,
	): Promise<T>;
	/** With `E2E_SHOTS` set, a PNG of the window or one element under `artifacts/e2e-shots/`. */
	shot(name: string, selector?: string): Promise<void>;
	stop(): Promise<void>;
}

export async function launchObsidian(options: {
	port: number;
	/** The plugin's data.json. */
	settings: object;
	files?: Record<string, string>;
	/** Other community plugins' folders, each named by its plugin id. */
	plugins?: string[];
}): Promise<Obsidian> {
	const root = mkdtempSync(join(tmpdir(), "obsync-e2e-"));
	const userData = join(root, "userdata");
	const vault = join(root, "vault");
	const pluginDir = join(vault, ".obsidian", "plugins", "obsync");
	mkdirSync(pluginDir, { recursive: true });
	mkdirSync(userData);
	for (const file of PLUGIN_FILES) {
		copyFileSync(join(REPO, file), join(pluginDir, basename(file)));
	}
	writeJson(join(pluginDir, "data.json"), options.settings);
	const others = (options.plugins ?? []).map((dir) => {
		cpSync(dir, join(vault, ".obsidian", "plugins", basename(dir)), {
			recursive: true,
		});
		return basename(dir);
	});
	writeJson(join(vault, ".obsidian", "community-plugins.json"), [
		"obsync",
		...others,
	]);
	writeJson(join(userData, "obsidian.json"), {
		vaults: {
			[randomBytes(8).toString("hex")]: {
				path: vault,
				ts: Date.now(),
				open: true,
			},
		},
	});
	for (const [path, text] of Object.entries(options.files ?? {})) {
		mkdirSync(dirname(join(vault, path)), { recursive: true });
		writeFileSync(join(vault, path), text);
	}

	const child = spawn(
		EXE,
		[`--remote-debugging-port=${options.port}`, `--user-data-dir=${userData}`],
		{ stdio: "ignore" },
	);
	const exited = once(child, "exit");
	const stopProcess = async () => {
		killTree(child);
		await exited;
		// The killed helpers let go of the profile a moment after the main process.
		rmSync(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 300,
		});
	};

	try {
		const { browser, page } = await poll("Obsidian window", () =>
			attach(options.port),
		);
		const obsidian: Obsidian = {
			vault,
			evaluate: page.evaluate.bind(page),
			waitFor: <T>(label: string, fn: () => T, accept: (value: T) => boolean) =>
				poll(label, async () => {
					const value = (await page.evaluate(fn)) as T;
					return accept(value) ? value : undefined;
				}),
			shot: async (name, selector) => {
				if (!process.env.E2E_SHOTS) return;
				const target = selector ? page.locator(selector).first() : page;
				await target.screenshot({ path: `artifacts/e2e-shots/${name}.png` });
			},
			stop: async () => {
				await browser.close().catch(() => undefined);
				await stopProcess();
			},
		};
		// A fresh device asks before running a vault's community plugins.
		const trust = page.getByRole("button", { name: TRUST_BUTTON });
		await poll("plugin loaded", async () => {
			if (await trust.isVisible()) await trust.click();
			const loaded = await page.evaluate(
				() => typeof app !== "undefined" && Boolean(app.plugins.plugins.obsync),
			);
			return loaded || undefined;
		});
		return obsidian;
	} catch (error) {
		await stopProcess();
		throw error;
	}
}

declare const app: { plugins: { plugins: Record<string, unknown> } };

async function attach(port: number) {
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const page: Page | undefined = browser
		.contexts()
		.flatMap((context) => context.pages())
		.find((candidate) => candidate.url().startsWith(APP_URL));
	if (page) return { browser, page };
	await browser.close();
	return undefined;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value));
}
