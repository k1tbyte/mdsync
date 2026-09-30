/**
 * The relay's `/share/sign` handler run in-process (node, not workerd) over an
 * in-memory KV that counts reads: what one sign costs the Worker, for the
 * quota and CPU-limit arithmetic.
 */

import { performance } from "node:perf_hooks";

import type { Jiti } from "jiti";

interface CountingKv {
	get(key: string, type?: "json"): Promise<unknown>;
}

interface RelayModules {
	share: {
		handleShareRequest(
			request: Request,
			env: unknown,
			url: URL,
		): Promise<Response | null>;
	};
	sigv4: {
		presignS3(
			target: unknown,
			method: string,
			key: string,
			expiresIn: number,
		): Promise<string>;
	};
	fakeKv: { FakeKV: new () => CountingKv };
}

export interface BatchCost {
	wallMs: number;
	cpuMs: number;
}

export interface HandlerCost {
	kvReadsPerSign: number;
	microsPerSign: number;
	/** 100 `presignS3` calls as the relay makes them. */
	presign: BatchCost;
	/** Projection: 100 signatures under one already derived signing key. */
	cachedKey: BatchCost;
}

const SECRET = "bench-secret";
const SHARE = "costshare";
const STORAGE = {
	endpoint: "https://s3.example.com",
	region: "us-east-1",
	bucket: "bucket",
	prefix: "vault",
	accessKeyId: "AKIA",
	secretAccessKey: "secret",
	forcePathStyle: true,
};
const SIGNS = 2000;
const BATCH = 100;
const BATCHES = 50;
const encoder = new TextEncoder();

async function loadRelay(jiti: Jiti): Promise<RelayModules> {
	const src = "../../packages/relay/src";
	const [share, sigv4, fakeKv] = await Promise.all([
		jiti.import<RelayModules["share"]>(`${src}/share/broker`),
		jiti.import<RelayModules["sigv4"]>(`${src}/share/sigv4`),
		jiti.import<RelayModules["fakeKv"]>(`${src}/../tests/helpers/fake-kv`),
	]);
	return { share, sigv4, fakeKv };
}

export async function measureHandler(jiti: Jiti): Promise<HandlerCost> {
	const { share, sigv4, fakeKv } = await loadRelay(jiti);
	const kv = new fakeKv.FakeKV();
	let reads = 0;
	const get = kv.get.bind(kv);
	kv.get = (key, type) => {
		reads++;
		return get(key, type);
	};
	const env = { SHARE_TOKENS: kv, RELAY_SECRET: SECRET };

	const call = async (path: string, init: RequestInit): Promise<Response> => {
		const url = new URL(`https://relay.example.com${path}`);
		const response = await share.handleShareRequest(
			new Request(url, init),
			env,
			url,
		);
		if (!response?.ok) throw new Error(`${path} answered ${response?.status}`);
		return response;
	};
	const admin = {
		"X-Obsync-Admin": SECRET,
		"Content-Type": "application/json",
	};
	await call(`/share/shares/${SHARE}`, {
		method: "PUT",
		headers: admin,
		body: JSON.stringify(STORAGE),
	});
	const issued = await call("/share/tokens", {
		method: "POST",
		headers: admin,
		body: JSON.stringify({
			shareId: SHARE,
			participantId: "p1",
			role: "ro",
		}),
	});
	const { token } = (await issued.json()) as { token: string };
	const sign = (index: number) =>
		call("/share/sign", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ op: "get", key: `objects/${index}` }),
		});

	for (let i = 0; i < 200; i++) await sign(i);
	reads = 0;
	const started = performance.now();
	for (let i = 0; i < SIGNS; i++) await sign(i);
	const signMs = performance.now() - started;
	const kvReadsPerSign = reads / SIGNS;

	const presign = await perBatch(async () => {
		for (let i = 0; i < BATCH; i++) {
			await sigv4.presignS3(
				STORAGE,
				"GET",
				`vault/shares/${SHARE}/o/${i}`,
				120,
			);
		}
	});
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode("secret"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const cachedKey = await perBatch(async () => {
		for (let i = 0; i < BATCH; i++) {
			const request = encoder.encode(
				`GET\n/bucket/vault/shares/${SHARE}/o/${i}\n${"x".repeat(220)}`,
			);
			await crypto.subtle.sign(
				"HMAC",
				key,
				await crypto.subtle.digest("SHA-256", request),
			);
		}
	});
	return {
		kvReadsPerSign,
		microsPerSign: (signMs / SIGNS) * 1000,
		presign,
		cachedKey,
	};
}

/** Per 100 keys: wall and CPU (all threads, so crypto workers count). */
async function perBatch(run: () => Promise<void>): Promise<BatchCost> {
	const cpuStarted = process.cpuUsage();
	const started = performance.now();
	for (let round = 0; round < BATCHES; round++) await run();
	const cpu = process.cpuUsage(cpuStarted);
	return {
		wallMs: (performance.now() - started) / BATCHES,
		cpuMs: (cpu.user + cpu.system) / 1000 / BATCHES,
	};
}
