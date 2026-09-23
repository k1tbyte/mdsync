/** Scenario plumbing shared by the end-to-end checks. */

import { type ChildProcess, spawnSync } from "node:child_process";

const POLL_MS = 200;
const POLL_TIMEOUT_MS = 30_000;

/** Throws on the first broken expectation: later steps build on earlier ones. */
export function check(name: string, actual: unknown, expected: unknown): void {
	const got = JSON.stringify(actual);
	const want = JSON.stringify(expected);
	if (got !== want) throw new Error(`${name}: got ${got}, want ${want}`);
	console.log(`ok   ${name}`);
}

/** Retries until `probe` yields a value; a throwing probe means "not yet". */
export async function poll<T>(
	label: string,
	probe: () => Promise<T | undefined>,
	timeoutMs = POLL_TIMEOUT_MS,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value !== undefined) return value;
		} catch (error) {
			last = error;
		}
		await sleep(POLL_MS);
	}
	throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shell-spawned tools are grandchildren; only a tree kill reaches them on Windows. */
export function killTree(child: ChildProcess): void {
	if (process.platform === "win32" && child.pid) {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
		});
		return;
	}
	child.kill();
}

/** Open sockets and child processes would keep node alive, so this exits. */
export async function runScenario(
	name: string,
	body: () => Promise<void>,
): Promise<never> {
	try {
		await body();
	} catch (error) {
		console.error(
			`\n${name} failed: ${error instanceof Error ? error.message : error}`,
		);
		process.exit(1);
	}
	console.log(`\n${name} passed`);
	process.exit(0);
}
