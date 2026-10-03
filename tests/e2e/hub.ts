/**
 * The relay hub under a real workerd: the only coverage of the Durable Object shell,
 * hibernating sockets, keepalive auto-response and SQLite logs that must outlive a restart.
 */

import {
	type ClientFrame,
	deriveChannelGrant,
	EFrame,
	KEEPALIVE_PING,
	shareChannel,
} from "@mdsync/protocol";

import { check, runScenario } from "./harness";
import { connectPeer, type Peer } from "./peer";
import { type Relay, startRelay } from "./relay";

const PORT = 8799;
const SECRET = "e2e-secret";
const VAULT = `e2e-vault-${Date.now()}`;
const DOC = Date.now().toString(16).padStart(32, "0");
/** Rotation seeds its target, so each run needs one no earlier run left a log in. */
const NEXT = `f${DOC.slice(1)}`;
const SWEPT = "e".repeat(32);
/** A short stale window, so the sweep is seen in seconds. */
const STALE_MS = 1_500;

type Unaddressed<F = ClientFrame> = F extends ClientFrame
	? Omit<F, "slot" | "doc">
	: never;

await runScenario("hub e2e", async () => {
	let relay: Relay | null = await startRelay(PORT, SECRET);
	try {
		await scenario(relay.url);
		const log = await documents(relay.url);
		const ended = await endShare(relay.url);
		relay.stop();
		relay = await startRelay(PORT, SECRET);
		await afterRestart(relay.url, log);
		check(
			"an ended share stays shut after a restart",
			(await (await connectPeer(relay.url, [ended], "late-pc")).next("close"))
				.code,
			4001,
		);
		relay.stop();
		relay = await startRelay(PORT, SECRET, {
			HUB_STALE_MS: String(STALE_MS),
		});
		await sweep(relay.url);
	} finally {
		relay?.stop();
	}
});

async function sweep(url: string): Promise<void> {
	const grant = await deriveChannelGrant(SECRET, VAULT);
	const alive = await connectPeer(url, [[VAULT, grant]], "alive");
	const keepalive = setInterval(() => alive.raw(KEEPALIVE_PING), STALE_MS / 4);
	const silent = await connectPeer(url, [[VAULT, grant]], "silent");
	for (const peer of [alive, silent]) {
		peer.send({ type: EFrame.Sub, slot: 0, doc: SWEPT, since: 0 });
		await peer.next(EFrame.State);
	}

	check(
		"a socket that stopped pinging is closed",
		(await silent.next("close", STALE_MS * 4)).code,
		1001,
	);
	const leaves = [
		await alive.next(EFrame.Leave),
		await alive.next(EFrame.Leave),
	];
	check(
		"its departure reaches the channel and the document",
		leaves.map((leave) => leave.doc).sort(),
		["", SWEPT],
	);
	check(
		"a pinging socket stays",
		await alive.quiet("close", STALE_MS * 2),
		true,
	);
	clearInterval(keepalive);
	alive.close();
}

/** Returns the name of the document's log. */
async function documents(url: string): Promise<string> {
	const grant = await deriveChannelGrant(SECRET, VAULT);
	const laptop = await connectPeer(url, [[VAULT, grant]], "laptop");
	const phone = await connectPeer(url, [[VAULT, grant]], "phone");
	const doc = (peer: Peer, frame: Unaddressed) =>
		peer.send({ ...frame, slot: 0, doc: DOC } as ClientFrame);

	doc(laptop, { type: EFrame.Sub, since: 0 });
	check("empty document", (await laptop.next(EFrame.State)).head, 0);
	doc(phone, { type: EFrame.Sub, since: 0 });
	await phone.next(EFrame.State);
	await laptop.next(EFrame.Join);

	doc(laptop, { type: EFrame.Seed, n: 0, payload: Uint8Array.of(1) });
	check("seed acked with its seq", (await laptop.next(EFrame.Echo)).seq, 1);
	check(
		"seed reaches the follower",
		[...(await phone.next(EFrame.Fanout)).payload],
		[1],
	);
	doc(phone, { type: EFrame.Seed, n: 0, payload: Uint8Array.of(3) });
	const room = await phone.next(EFrame.State);
	check(
		"late seed answered with the room",
		[room.head, room.deltas.map((delta) => [...delta])],
		[1, [[1]]],
	);
	check("the log is named", /^[0-9a-f]{16}$/.test(room.log), true);
	doc(laptop, { type: EFrame.Update, n: 5, payload: Uint8Array.of(2) });
	check("update echo names its counter", (await laptop.next(EFrame.Echo)).n, 5);
	doc(laptop, { type: EFrame.Snapshot, upto: 1, payload: Uint8Array.of(11) });

	doc(phone, { type: EFrame.Awareness, payload: Uint8Array.of(9) });
	check(
		"cursor reaches the follower",
		[...(await laptop.next(EFrame.Peer)).payload],
		[9],
	);

	phone.close();
	check(
		"follower departure announced",
		(await laptop.next(EFrame.Leave)).doc,
		DOC,
	);
	laptop.close();
	return room.log;
}

/** Ending a share cuts its channel and deletes its rows; returns its channel and grant. */
async function endShare(url: string): Promise<[string, string]> {
	const shareId = `e2eend${Date.now()}`;
	const channel = shareChannel(shareId);
	const grant = await deriveChannelGrant(SECRET, channel);
	const owner = await connectPeer(url, [[channel, grant]], "owner-pc");
	owner.send({ type: EFrame.Sub, slot: 0, doc: DOC, since: 0 });
	await owner.next(EFrame.State);
	owner.send({
		type: EFrame.Seed,
		slot: 0,
		doc: DOC,
		n: 0,
		payload: Uint8Array.of(7),
	});
	await owner.next(EFrame.Echo);

	const ended = await fetch(`${url}/share/shares/${shareId}`, {
		method: "DELETE",
		headers: { "X-Mdsync-Admin": SECRET },
	});
	check("share ended", ended.status, 200);
	check("its channel is cut", (await owner.next(EFrame.Revoked)).slot, 0);
	check(
		"the owner's socket with nothing left closes 4001",
		(await owner.next("close")).code,
		4001,
	);
	return [channel, grant];
}

async function afterRestart(url: string, log: string): Promise<void> {
	const grant = await deriveChannelGrant(SECRET, VAULT);
	const tablet = await connectPeer(url, [[VAULT, grant]], "tablet");
	tablet.send({ type: EFrame.Sub, slot: 0, doc: DOC, since: 0 });
	const state = await tablet.next(EFrame.State);
	check(
		"log survives a relay restart, under its name",
		[
			state.head,
			[...(state.snapshot ?? [])],
			state.deltas.map((d) => [...d]),
			state.log,
		],
		[2, [11], [[2]], log],
	);

	tablet.send({
		type: EFrame.Rotate,
		slot: 0,
		doc: DOC,
		target: NEXT,
		upto: state.head,
		note: new Uint8Array(),
		payload: Uint8Array.of(21),
	});
	check(
		"the rotator is pointed at the successor too",
		(await tablet.next(EFrame.Moved)).target,
		NEXT,
	);
	const late = await connectPeer(url, [[VAULT, grant]], "late");
	late.send({ type: EFrame.Sub, slot: 0, doc: DOC, since: 0 });
	check(
		"rotated document points at its successor",
		(await late.next(EFrame.Moved)).target,
		NEXT,
	);
	late.send({ type: EFrame.Sub, slot: 0, doc: NEXT, since: 0 });
	const successor = await late.next(EFrame.State);
	check(
		"the successor starts from the rebuilt document",
		[successor.head, successor.deltas.map((delta) => [...delta])],
		[1, [[21]]],
	);
	tablet.close();
	late.close();
}

async function scenario(url: string): Promise<void> {
	const grant = await deriveChannelGrant(SECRET, VAULT);
	const laptop = await connectPeer(url, [[VAULT, grant]], "laptop");
	const phone = await connectPeer(url, [[VAULT, grant]], "phone");
	check(
		"newcomer announced as owner",
		(await laptop.next(EFrame.Join)).who,
		"owner",
	);

	laptop.raw("ping");
	check("ping answered", (await laptop.next("text")).text, "pong");

	laptop.signal();
	await phone.next(EFrame.Signal);
	check("signal never echoes", await laptop.quiet(EFrame.Signal), true);

	laptop.announce({ id: "laptop", name: "Laptop" });
	const presence = await phone.next(EFrame.Peer);
	check(
		"presence fanned out",
		JSON.parse(new TextDecoder().decode(presence.payload)).id,
		"laptop",
	);

	const query = new URLSearchParams({ c: VAULT, t: grant, d: "laptop" });
	const posted = await fetch(`${url}/hub/signal?${query}`, { method: "POST" });
	check("http signal accepted", posted.status, 200);
	await phone.next(EFrame.Signal);
	check(
		"http signal skips its poster",
		await laptop.quiet(EFrame.Signal),
		true,
	);

	const stranger = await connectPeer(url, [[VAULT, "wrong"]], "stranger");
	check(
		"no valid grant closes 4001",
		(await stranger.next("close")).code,
		4001,
	);

	const shareId = `e2e${Date.now()}`;
	const share = `mdsync-share-${shareId}`;
	const issued = await fetch(`${url}/share/tokens`, {
		method: "POST",
		headers: { "X-Mdsync-Admin": SECRET, "Content-Type": "application/json" },
		body: JSON.stringify({ shareId, participantId: "p1" }),
	});
	const { token } = (await issued.json()) as { token: string };
	const guest = await connectPeer(
		url,
		[
			[share, token],
			[VAULT, "wrong"],
		],
		"guest",
	);
	check("refused slot reported", (await guest.next(EFrame.Revoked)).slot, 1);

	const owner = await connectPeer(
		url,
		[
			[VAULT, grant],
			[share, await deriveChannelGrant(SECRET, share)],
		],
		"owner-pc",
	);
	check(
		"owner joins the guest's channel",
		(await guest.next(EFrame.Join)).who,
		"owner",
	);
	guest.signal();
	check(
		"share signal lands on the owner's share slot",
		(await owner.next(EFrame.Signal)).slot,
		1,
	);
	check(
		"share signal stays out of the vault",
		await phone.quiet(EFrame.Signal),
		true,
	);

	await fetch(`${url}/share/tokens/p1?shareId=${shareId}`, {
		method: "DELETE",
		headers: { "X-Mdsync-Admin": SECRET },
	});
	check("revocation reported", (await guest.next(EFrame.Revoked)).slot, 0);
	check(
		"socket with nothing left closes 4001",
		(await guest.next("close")).code,
		4001,
	);
	check("owner sees the guest leave", (await owner.next(EFrame.Leave)).slot, 1);

	phone.close();
	await laptop.next(EFrame.Leave);
	laptop.close();
	owner.close();
}
