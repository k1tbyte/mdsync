/** The relay worker under `wrangler dev`, as a scenario resource. */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { killTree, poll } from "./harness";

const RELAY_DIR = fileURLToPath(
	new URL("../../packages/relay", import.meta.url),
);
/** A cold wrangler start builds the worker first. */
const START_TIMEOUT_MS = 60_000;

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
	const flags = Object.entries({ ...vars, RELAY_SECRET: secret })
		.map(([name, value]) => `--var ${name}:${value}`)
		.join(" ");
	// One command string: pnpm is a .cmd shim on Windows, which needs the shell.
	const child = spawn(`pnpm exec wrangler dev --port ${port} ${flags}`, {
		cwd: RELAY_DIR,
		stdio: "ignore",
		shell: true,
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
