/** Scenario plumbing shared by the end-to-end checks. */

import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
	spawnSync,
} from "node:child_process";

const POLL_MS = 200;
const POLL_TIMEOUT_MS = 30_000;
const TAIL_LINES = 50;

/** Last output of each child by label; a restart under the same label replaces it. */
const tails = new Map<string, () => string>();

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

const WINDOWS = process.platform === "win32";

/** Spawn option for `killTree`: elsewhere the child must lead its own process group. */
export const OWN_GROUP = { detached: !WINDOWS };

/** Shell-spawned tools are grandchildren: a tree kill on Windows, the group elsewhere. */
export function killTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (WINDOWS) {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
		});
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

export function lastLines(text: string): string {
	return text.split("\n").slice(-TAIL_LINES).join("\n");
}

/** Spawns a child whose stdout and stderr tail is printed by `runScenario` when the scenario fails. */
export function spawnLogged(
	label: string,
	command: string,
	args: string[],
	options: SpawnOptions,
): ChildProcess {
	const child = spawn(command, args, {
		...options,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let tail = "";
	tails.set(label, () => tail);
	for (const stream of [child.stdout, child.stderr]) {
		stream?.on("data", (chunk) => {
			tail = lastLines(tail + chunk);
		});
	}
	return child;
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
			`\n${name} failed: ${error instanceof Error ? (error.stack ?? error) : error}`,
		);
		for (const [label, tail] of tails) {
			console.error(
				`\n--- ${label}, last ${TAIL_LINES} lines ---\n${tail().trim()}`,
			);
		}
		process.exit(1);
	}
	console.log(`\n${name} passed`);
	process.exit(0);
}
