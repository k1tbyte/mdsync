/** The relay worker under `wrangler dev`, as a scenario resource. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { killTree, lastLines, OWN_GROUP, poll, spawnLogged } from "./harness";

const RELAY_DIR = fileURLToPath(
	new URL("../../packages/relay", import.meta.url),
);
/** A cold wrangler start builds the worker first. */
const START_TIMEOUT_MS = 60_000;

/** One per run, shared by restarts: scenarios check what a restarted relay kept, no older run may leak in. */
let stateDir: string | undefined;

export interface Relay {
	url: string;
	secret: string;
	stop(): void;
}

export async function startRelay(
	port: number,
	secret: string,
	vars: Record<string, string> = {},
): Promise<Relay> {
	const url = `http://127.0.0.1:${port}`;
	if (await answers(url)) throw new Error(`${url} is taken by another relay`);
	if (!stateDir) {
		// wrangler refuses to start when the assets directory the worker names is missing.
		const built = spawnSync("pnpm --filter mdsync-viewer run build", {
			cwd: RELAY_DIR,
			shell: true,
			encoding: "utf8",
		});
		if (built.status !== 0) {
			throw new Error(
				`the link viewer did not build:\n${lastLines(built.stdout + built.stderr)}`,
			);
		}
		const dir = mkdtempSync(join(tmpdir(), "mdsync-relay-"));
		// Restarts must see the same state, so it goes when the run ends (process.exit runs this too).
		process.on("exit", () =>
			rmSync(dir, { recursive: true, force: true, maxRetries: 10 }),
		);
		// A signal ends the process without "exit" unless something exits on it.
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => process.exit(130));
		}
		stateDir = dir;
	}
	const flags = Object.entries({ ...vars, RELAY_SECRET: secret })
		.map(([name, value]) => `--var ${name}:${value}`)
		.join(" ");
	// One command string: pnpm is a .cmd shim on Windows, which needs the shell.
	const command = `pnpm exec wrangler dev --port ${port} --persist-to "${stateDir}" ${flags}`;
	const child = spawnLogged(`wrangler dev :${port}`, command, [], {
		cwd: RELAY_DIR,
		shell: true,
		...OWN_GROUP,
	});
	const relay = { url, secret, stop: () => killTree(child) };
	try {
		await poll(
			"wrangler dev",
			async () => ((await answers(url)) ? true : undefined),
			START_TIMEOUT_MS,
		);
	} catch (error) {
		relay.stop();
		throw error;
	}
	return relay;
}

async function answers(url: string): Promise<boolean> {
	try {
		await fetch(`${url}/status`);
		return true;
	} catch {
		return false;
	}
}
