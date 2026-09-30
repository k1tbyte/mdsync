/** The relay worker under `wrangler dev`, as a scenario resource. */

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { killTree, OWN_GROUP, poll } from "./harness";

const RELAY_DIR = fileURLToPath(
	new URL("../../packages/relay", import.meta.url),
);
/** Relative to the relay; kept across restarts within a run, wiped at its first start. */
const STATE_DIR = ".wrangler/e2e-state";
/** A cold wrangler start builds the worker first. */
const START_TIMEOUT_MS = 60_000;

let wiped = false;

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
	// Storage left by an older build may hold tables of another shape.
	if (!wiped) {
		rmSync(join(RELAY_DIR, STATE_DIR), { recursive: true, force: true });
		wiped = true;
	}
	const flags = Object.entries({ ...vars, RELAY_SECRET: secret })
		.map(([name, value]) => `--var ${name}:${value}`)
		.join(" ");
	// One command string: pnpm is a .cmd shim on Windows, which needs the shell.
	const command = `pnpm exec wrangler dev --port ${port} --persist-to ${STATE_DIR} ${flags}`;
	const child = spawn(command, {
		cwd: RELAY_DIR,
		stdio: "ignore",
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
