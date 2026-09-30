import {
	deriveChannelGrant,
	EFrame,
	ERefusal,
	HUB_SIGNAL_PATH,
	OWNER,
	shareChannel,
	UNAUTHORIZED_CLOSE_CODE,
} from "@obsync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectPeer } from "../helpers/socket";
import { startWorker, type Worker } from "../helpers/worker";

const SECRET = "integration-secret";
const STALE_MS = 2_000;
const DOC = "d".repeat(32);
const SWEPT_DOC = "e".repeat(32);
const STALE_CLOSE_CODE = 1001;

let worker: Worker;
let sweeping: Worker;

beforeAll(async () => {
	worker = await startWorker({ RELAY_SECRET: SECRET });
	sweeping = await startWorker({
		RELAY_SECRET: SECRET,
		HUB_STALE_MS: String(STALE_MS),
	});
}, 60_000);

afterAll(() => Promise.all([worker?.stop(), sweeping?.stop()]));

async function ownerOf(channel: string, device: string, url = worker.url) {
	const grant = await deriveChannelGrant(SECRET, channel);
	return connectPeer(url, [[channel, grant]], device);
}

describe("the relay worker under workerd", { timeout: 60_000 }, () => {
	it("closes a socket with a bad grant as unauthorized", async () => {
		const stranger = await connectPeer(worker.url, [["vault", "bad"]], "pc");
		expect(await stranger.closeCode()).toBe(UNAUTHORIZED_CLOSE_CODE);
	});

	it("tells a newcomer who is here and the channel who arrived and left", async () => {
		const laptop = await ownerOf("presence", "laptop");
		const phone = await ownerOf("presence", "phone");

		const joined = await laptop.next(EFrame.Join);
		const here = await phone.next(EFrame.Here);
		expect([joined.who, here.who]).toEqual([OWNER, OWNER]);
		expect(here.from).not.toBe(joined.from);

		phone.close();
		expect((await laptop.next(EFrame.Leave)).from).toBe(joined.from);
		laptop.close();
	});

	it("fans a write out and serves it cold to a later subscriber", async () => {
		const laptop = await ownerOf("documents", "laptop");
		const phone = await ownerOf("documents", "phone");
		for (const peer of [laptop, phone]) {
			peer.send({ type: EFrame.Sub, slot: 0, doc: DOC, since: 0 });
			expect((await peer.next(EFrame.State)).head).toBe(0);
		}

		laptop.send({
			type: EFrame.Seed,
			slot: 0,
			doc: DOC,
			payload: Uint8Array.of(1),
		});
		expect((await laptop.next(EFrame.Echo)).seq).toBe(1);
		expect([...(await phone.next(EFrame.Fanout)).payload]).toEqual([1]);
		laptop.send({
			type: EFrame.Update,
			slot: 0,
			doc: DOC,
			payload: Uint8Array.of(2),
		});
		expect((await laptop.next(EFrame.Echo)).seq).toBe(2);
		expect([...(await phone.next(EFrame.Fanout)).payload]).toEqual([2]);

		const tablet = await ownerOf("documents", "tablet");
		tablet.send({ type: EFrame.Sub, slot: 0, doc: DOC, since: 0 });
		const state = await tablet.next(EFrame.State);
		expect(state.head).toBe(2);
		expect(state.deltas.map((delta) => [...delta])).toEqual([[1], [2]]);
		for (const peer of [laptop, phone, tablet]) peer.close();
	});

	it("refuses a read-only share token's write and keeps the log", async () => {
		const shareId = "readonlyshare";
		const channel = shareChannel(shareId);
		const issued = await fetch(`${worker.url}/share/tokens`, {
			method: "POST",
			headers: {
				"X-Obsync-Admin": SECRET,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				shareId,
				participantId: "viewer",
				role: "ro",
				label: "Viewer",
			}),
		});
		const { token } = (await issued.json()) as { token: string };

		const owner = await ownerOf(channel, "owner-pc");
		const viewer = await connectPeer(
			worker.url,
			[[channel, token]],
			"viewer-pc",
		);
		const arrived = await owner.next(EFrame.Join);
		expect(arrived).toMatchObject({ who: "viewer", name: "Viewer" });
		for (const peer of [owner, viewer]) {
			peer.send({ type: EFrame.Sub, slot: 0, doc: DOC, since: 0 });
			await peer.next(EFrame.State);
		}

		viewer.send({
			type: EFrame.Update,
			slot: 0,
			doc: DOC,
			payload: Uint8Array.of(9),
		});
		expect((await viewer.next(EFrame.Refused)).reason).toBe(ERefusal.ReadOnly);
		owner.send({
			type: EFrame.Update,
			slot: 0,
			doc: DOC,
			payload: Uint8Array.of(1),
		});
		expect((await owner.next(EFrame.Echo)).seq).toBe(1);
		expect(owner.has(EFrame.Fanout)).toBe(false);
		owner.close();
		viewer.close();
	});

	it("wakes the other device on an HTTP signal but not the sender", async () => {
		const grant = await deriveChannelGrant(SECRET, "signals");
		const laptop = await ownerOf("signals", "laptop");
		const phone = await ownerOf("signals", "phone");

		const query = new URLSearchParams({ c: "signals", t: grant, d: "laptop" });
		const posted = await fetch(`${worker.url}${HUB_SIGNAL_PATH}?${query}`, {
			method: "POST",
		});
		expect(posted.status).toBe(200);
		await phone.next(EFrame.Signal);

		laptop.send({ type: EFrame.Sub, slot: 0, doc: DOC, since: 0 });
		await laptop.next(EFrame.State);
		expect(laptop.has(EFrame.Signal)).toBe(false);
		laptop.close();
		phone.close();
	});

	it("sweeps a silent socket and announces its departure", async () => {
		const alive = await ownerOf("sweep", "alive", sweeping.url);
		const silent = await ownerOf("sweep", "silent", sweeping.url);
		const keepalive = setInterval(() => alive.ping(), STALE_MS / 8);
		try {
			for (const peer of [alive, silent]) {
				peer.send({ type: EFrame.Sub, slot: 0, doc: SWEPT_DOC, since: 0 });
				await peer.next(EFrame.State);
			}

			expect(await silent.closeCode()).toBe(STALE_CLOSE_CODE);
			const leaves = [
				await alive.next(EFrame.Leave),
				await alive.next(EFrame.Leave),
			];
			expect(leaves.map((leave) => leave.doc).sort()).toEqual(["", SWEPT_DOC]);
			expect(alive.isOpen()).toBe(true);
		} finally {
			clearInterval(keepalive);
			alive.close();
		}
	});
});
