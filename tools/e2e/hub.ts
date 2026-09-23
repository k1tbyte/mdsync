/**
 * The relay hub under a real workerd: the only coverage of the Durable Object
 * shell, its hibernating sockets, the keepalive auto-response and the document
 * logs in its SQLite, which must outlive a relay restart.
 */

import { type ClientFrame, deriveChannelGrant, EFrame } from "@obsync/protocol";

import { check, runScenario } from "./harness";
import { connectPeer, type Peer } from "./peer";
import { type Relay, startRelay } from "./relay";

const PORT = 8799;
const SECRET = "e2e-secret";
const VAULT = `e2e-vault-${Date.now()}`;
const DOC = Date.now().toString(16).padStart(32, "0");
const NEXT = "f".repeat(32);

type Unaddressed<F = ClientFrame> = F extends ClientFrame
	? Omit<F, "slot" | "doc">
	: never;

await runScenario("hub e2e", async () => {
	let relay: Relay | null = await startRelay(PORT, SECRET);
	try {
		await scenario(relay.url);
		await documents(relay.url);
		relay.stop();
		relay = await startRelay(PORT, SECRET);
		await afterRestart(relay.url);
	} finally {
		relay?.stop();
	}
});

async function documents(url: string): Promise<void> {
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

	doc(laptop, { type: EFrame.Update, payload: Uint8Array.of(1) });
	check("update acked with its seq", (await laptop.next(EFrame.Echo)).seq, 1);
	check(
		"update reaches the follower",
		[...(await phone.next(EFrame.Fanout)).payload],
		[1],
	);
	doc(laptop, { type: EFrame.Update, payload: Uint8Array.of(2) });
	await laptop.next(EFrame.Echo);
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
}

async function afterRestart(url: string): Promise<void> {
	const grant = await deriveChannelGrant(SECRET, VAULT);
	const tablet = await connectPeer(url, [[VAULT, grant]], "tablet");
	tablet.send({ type: EFrame.Sub, slot: 0, doc: DOC, since: 0 });
	const state = await tablet.next(EFrame.State);
	check(
		"log survives a relay restart",
		[state.head, [...(state.snapshot ?? [])], state.deltas.map((d) => [...d])],
		[2, [11], [[2]]],
	);

	tablet.send({ type: EFrame.Rotate, slot: 0, doc: DOC, target: NEXT });
	const late = await connectPeer(url, [[VAULT, grant]], "late");
	late.send({ type: EFrame.Sub, slot: 0, doc: DOC, since: 0 });
	check(
		"rotated document points at its successor",
		(await late.next(EFrame.Moved)).target,
		NEXT,
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
	const share = `obsync-share-${shareId}`;
	const issued = await fetch(`${url}/share/tokens`, {
		method: "POST",
		headers: { "X-Obsync-Admin": SECRET, "Content-Type": "application/json" },
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
		headers: { "X-Obsync-Admin": SECRET },
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
