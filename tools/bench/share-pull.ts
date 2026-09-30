/**
 * Measures a share participant's first pull: one `/share/sign` on the owner's
 * relay, then the object from the bucket, per file, through the plugin's real
 * broker adapter and concurrency helper, against the same objects fetched
 * from S3 directly. Real relay (`wrangler dev`), in-memory S3, and optional
 * added round-trip delay in front of both. Results are in
 * docs/share-pull-measurements.md.
 *
 * BENCH_SIZES, BENCH_RTT_MS, BENCH_CONCURRENCY: comma lists to narrow the run.
 * BENCH_SIGN_RTT_MS: the relay's round trip when it differs from the bucket's.
 * BENCH_WORKER_MS: extra time added to each sign, to model KV reads.
 * BENCH_REPS: repeats per cell (default 3 raw, 1 with delay).
 * BENCH_BATCH=0: pull without the read hint, one sign per file (default: the
 * hint, signing in batches). The one-file-at-a-time probe never uses it.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

import type { StorageAdapter } from "@/storage/types";

import { runScenario } from "../e2e/harness";
import { startRelay } from "../e2e/relay";
import { startS3 } from "../e2e/s3";
import { startDelayProxy } from "./delay-proxy";
import { type BatchCost, measureHandler } from "./handler-cost";
import { latency, mean, median, type Pull, perSecond, seconds } from "./stats";

Object.assign(globalThis, { window: globalThis });

const RELAY_PORT = 8899;
const RELAY_PROXY_PORT = 8900;
const S3_PORT = 8902;
const S3_PROXY_PORT = 8903;
const ADMIN_SECRET = "bench-admin-secret";
const SHARE_ID = "benchshare";
const PREFIX = "bench";
const BASE = `${PREFIX}/shares/${SHARE_ID}/`;
const BODY_BYTES = 4096;
const SEED_CONCURRENCY = 32;
const PROBE_FILES = 100;

const list = (name: string, fallback: number[]): number[] =>
	process.env[name]?.split(",").map(Number) ?? fallback;
const SIZES = list("BENCH_SIZES", [100, 1000, 5000]);
const RTTS = list("BENCH_RTT_MS", [0, 30, 100]);
const CONCURRENCIES = list("BENCH_CONCURRENCY", [4, 8, 16]);
const WORKER_MS = Number(process.env.BENCH_WORKER_MS ?? 0);
const SIGN_RTT_MS = process.env.BENCH_SIGN_RTT_MS;
const BATCH = process.env.BENCH_BATCH !== "0";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const jiti = createJiti(import.meta.url, {
	tsconfigPaths: true,
	alias: {
		obsidian: here("./obsidian-shim.ts"),
		"cloudflare:workers": here(
			"../../packages/relay/tests/helpers/cloudflare-workers.ts",
		),
	},
});

const spans: { sign: number[]; object: number[] } = { sign: [], object: [] };
let signUrl = "";

function timeRequests(): void {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const started = performance.now();
		const res = await realFetch(input, init);
		const kind = String(input).startsWith(signUrl) ? "sign" : "object";
		const readBody = res.arrayBuffer.bind(res);
		res.arrayBuffer = async () => {
			const body = await readBody();
			spans[kind].push(performance.now() - started);
			return body;
		};
		return res;
	};
}

async function loadPlugin() {
	const [broker, s3, config, concurrency] = await Promise.all([
		jiti.import<typeof import("@/storage/adapters/share-broker")>(
			"@/storage/adapters/share-broker",
		),
		jiti.import<typeof import("@/storage/adapters/s3")>(
			"@/storage/adapters/s3",
		),
		jiti.import<typeof import("@/storage/config")>("@/storage/config"),
		jiti.import<typeof import("@/utils/concurrency")>("@/utils/concurrency"),
	]);
	return { broker, s3, config, concurrency };
}

type Plugin = Awaited<ReturnType<typeof loadPlugin>>;

const objectKeys = (count: number): string[] =>
	Array.from(
		{ length: count },
		(_, i) => `objects/${createHash("sha256").update(String(i)).digest("hex")}`,
	);

function printHandlerCost(cost: Awaited<ReturnType<typeof measureHandler>>) {
	const batch = (label: string, { wallMs, cpuMs }: BatchCost) =>
		`${label}: ${wallMs.toFixed(1)} ms wall, ${cpuMs.toFixed(1)} ms cpu per 100`;
	console.log(
		[
			`relay handler in-process (node, not workerd): ${cost.kvReadsPerSign} KV reads per sign, ${cost.microsPerSign.toFixed(0)} us per sign`,
			batch("presignS3", cost.presign),
			batch("signing key derived once (projection)", cost.cachedKey),
			"",
		].join("\n"),
	);
}

async function main(plugin: Plugin): Promise<void> {
	const { broker, s3: s3Adapter, config, concurrency } = plugin;
	const { runWithConcurrency } = concurrency;
	printHandlerCost(await measureHandler(jiti));

	const s3 = await startS3(S3_PORT);
	const s3Proxy = await startDelayProxy(S3_PROXY_PORT, s3.url);
	const relay = await startRelay(RELAY_PORT, ADMIN_SECRET);
	const relayProxy = await startDelayProxy(RELAY_PROXY_PORT, relay.url);
	const stopAll = () => {
		relayProxy.stop();
		s3Proxy.stop();
		relay.stop();
		s3.stop();
	};
	process.once("SIGINT", () => {
		stopAll();
		process.exit(130);
	});
	try {
		timeRequests();
		const s3Config = (endpoint: string, prefix: string) => ({
			kind: config.EStorageBackend.S3,
			endpoint,
			region: "us-east-1",
			bucket: s3.bucket,
			prefix,
			accessKeyId: "AKIABENCH",
			secretAccessKey: "secret",
			forcePathStyle: true,
			concurrency: 4,
		});
		const admin = { relayUrl: relay.url, secret: ADMIN_SECRET };
		const token = await broker.issueShareToken(admin, {
			shareId: SHARE_ID,
			participantId: "bench-participant",
			label: "bench",
			readOnly: true,
		});

		const allKeys = objectKeys(Math.max(...SIZES));
		await runWithConcurrency(allKeys, SEED_CONCURRENCY, async (key) => {
			const res = await fetch(`${s3.url}/${s3.bucket}/${BASE}${key}`, {
				method: "PUT",
				body: randomBytes(BODY_BYTES),
			});
			assert(res.ok, `seeding ${key} answered ${res.status}`);
		});
		console.log(`seeded ${allKeys.length} objects of ${BODY_BYTES} bytes`);

		const pull = async (
			adapter: StorageAdapter,
			keys: string[],
			parallel: number,
			hint = false,
		): Promise<Pull> => {
			spans.sign = [];
			spans.object = [];
			const fileMs: number[] = [];
			const cpuStarted = process.cpuUsage();
			const started = performance.now();
			if (hint) adapter.prepareReads?.(keys);
			await runWithConcurrency(keys, parallel, async (key) => {
				const fileStarted = performance.now();
				const body = await adapter.get(key);
				assert(body?.length === BODY_BYTES, `${key} came back wrong`);
				fileMs.push(performance.now() - fileStarted);
			});
			const ms = performance.now() - started;
			const cpu = process.cpuUsage(cpuStarted);
			const cpuPct = ((cpu.user + cpu.system) / 1000 / ms) * 100;
			return { ms, cpuPct, signMs: spans.sign, objectMs: spans.object, fileMs };
		};

		for (const rtt of RTTS) {
			const modeled = rtt > 0 || WORKER_MS > 0 || SIGN_RTT_MS !== undefined;
			const relayUrl = modeled ? relayProxy.url : relay.url;
			const s3Url = modeled ? s3Proxy.url : s3.url;
			relayProxy.setDelay(Number(SIGN_RTT_MS ?? rtt) + WORKER_MS);
			s3Proxy.setDelay(rtt);
			signUrl = `${relayUrl}/share/sign`;
			await broker.registerShareStorage(
				admin,
				SHARE_ID,
				s3Config(s3Url, PREFIX),
			);
			const viaBroker = broker.createBrokerAdapter(SHARE_ID, {
				relayUrl,
				token,
			});
			const direct = s3Adapter.createS3Adapter(s3Config(s3Url, BASE));
			const reps = Number(process.env.BENCH_REPS ?? (modeled ? 1 : 3));

			const probeKeys = allKeys.slice(0, PROBE_FILES);
			const probe = await pull(viaBroker, probeKeys, 1);
			const probeDirect = await pull(direct, probeKeys, 1);
			console.log(
				`\n### ${modeled ? `bucket RTT ${rtt} ms, relay RTT ${SIGN_RTT_MS ?? rtt} ms + ${WORKER_MS} ms worker` : "raw localhost"}\n\nOne file at a time over ${PROBE_FILES} files, p50/mean/p95 ms: sign ${latency(probe.signMs)}, object via broker ${latency(probe.objectMs)}, object direct ${latency(probeDirect.objectMs)}\n`,
			);
			console.log(
				"| files | conc | direct s | broker s | broker/direct | direct files/s | broker files/s | broker HTTP req/s | sign ms p50/mean/p95 | object ms p50/mean/p95 | file ms mean direct/broker | bench process cpu % | sign share of pull |",
			);
			console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
			for (const size of SIZES) {
				const keys = allKeys.slice(0, size);
				for (const parallel of CONCURRENCIES) {
					const viaDirect: Pull[] = [];
					const viaRelay: Pull[] = [];
					for (let rep = 0; rep < reps; rep++) {
						viaDirect.push(await pull(direct, keys, parallel));
						viaRelay.push(await pull(viaBroker, keys, parallel, BATCH));
					}
					const [d, b] = [median(viaDirect), median(viaRelay)];
					const times = viaRelay.map((run) => run.ms);
					const range =
						reps > 1
							? ` (${seconds(Math.min(...times))}-${seconds(Math.max(...times))})`
							: "";
					console.log(
						`| ${size} | ${parallel} | ${seconds(d.ms)} | ${seconds(b.ms)}${range} | ${(b.ms / d.ms).toFixed(2)}x | ${perSecond(size, d.ms)} | ${perSecond(size, b.ms)} | ${perSecond(b.signMs.length + b.objectMs.length, b.ms)} | ${latency(b.signMs)} | ${latency(b.objectMs)} | ${mean(d.fileMs).toFixed(1)}/${mean(b.fileMs).toFixed(1)} | ${d.cpuPct.toFixed(0)}/${b.cpuPct.toFixed(0)} | ${(((b.ms - d.ms) / b.ms) * 100).toFixed(0)}% |`,
					);
					const retried =
						b.objectMs.length !== size || (!BATCH && b.signMs.length !== size);
					if (retried) {
						console.log(
							`  note: ${b.signMs.length} signs and ${b.objectMs.length} object requests for ${size} files (retries)`,
						);
					}
				}
			}
		}
	} finally {
		stopAll();
	}
}

await runScenario("share-pull bench", async () => main(await loadPlugin()));
