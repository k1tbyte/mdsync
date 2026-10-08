/**
 * Share links under a real workerd: the Link Durable Object's storage (chunks, erase, expiry, a restart),
 * the routes in front of it, and the sealed payload from the protocol package end to end.
 */

import {
	deriveLinkKeys,
	type LinkPayload,
	newLinkId,
	newLinkKey,
	newLinkSalt,
	openLinkPayload,
	sealLinkPayload,
	toBase64Url,
} from "@mdsync/protocol";

import { check, runScenario, sleep } from "./harness";
import { admin, open, put, SECRET } from "./link-client";
import { viewerScenario } from "./links-viewer";
import { type Relay, startRelay } from "./relay";

const PORT = 8799;
const VIEWS_LEFT = "X-Mdsync-Views-Left";

const payload: LinkPayload = {
	title: "Trip notes",
	html: "<p>Lisbon in <b>May</b></p>",
	createdAt: Date.now(),
};

await runScenario("links e2e", async () => {
	let relay: Relay | null = await startRelay(PORT, SECRET);
	try {
		await scenario(relay.url);
		await viewerScenario(relay.url);
		const survivor = await seal(newLinkId(), newLinkKey());
		await put(relay.url, survivor.id, survivor.sealed, "?maxViews=3", {
			"X-Mdsync-Gate": survivor.gate,
		});
		await open(relay.url, survivor.id, survivor.gate);
		relay.stop();
		relay = await startRelay(PORT, SECRET);
		const again = await open(relay.url, survivor.id, survivor.gate);
		check(
			"a restart keeps the blob and the counter",
			[again.status, again.headers.get(VIEWS_LEFT)],
			[200, "1"],
		);
	} finally {
		relay?.stop();
	}
});

async function scenario(base: string): Promise<void> {
	const id = newLinkId();
	const key = newLinkKey();
	const { sealed, content, gate } = await seal(id, key);

	check(
		"a stored link reports its size",
		await (await put(base, id, sealed, "", { "X-Mdsync-Gate": gate })).json(),
		{
			stored: true,
			size: sealed.length,
			expires: null,
		},
	);
	check(
		"the owner route refuses without the secret",
		(await fetch(`${base}/link/${id}/status`)).status,
		401,
	);
	const opened = await open(base, id, gate);
	const blob = new Uint8Array(await opened.arrayBuffer());
	check(
		"the sealed bytes come back whole and open",
		await openLinkPayload(id, blob, content),
		payload,
	);

	await oneView(base);
	await passphrase(base);
	await update(base);
	await expiry(base);
	await bigNote(base);
}

/** Spent links erase their storage; the same id must still take a new link afterwards. */
async function oneView(base: string): Promise<void> {
	const id = newLinkId();
	const { sealed, gate } = await seal(id, newLinkKey());
	const headers = { "X-Mdsync-Gate": gate };
	await put(base, id, sealed, "?maxViews=1", headers);
	const results = await Promise.all(
		Array.from({ length: 8 }, async () => (await open(base, id, gate)).status),
	);
	check(
		"one of eight simultaneous opens gets the only view",
		results.filter((s) => s === 200).length,
		1,
	);
	check("the spent link is gone", (await open(base, id, gate)).status, 404);
	check(
		"and so is its status",
		(await admin(base, `/link/${id}/status`)).status,
		404,
	);

	check(
		"an update cannot bring a spent link back",
		(await put(base, id, sealed, "?update=1&maxViews=2", headers)).status,
		404,
	);
	await put(base, id, sealed, "?maxViews=2", headers);
	check(
		"a new link takes the id of a spent one",
		(await open(base, id, gate)).headers.get(VIEWS_LEFT),
		"1",
	);
	check(
		"a creation never replaces a link that stands",
		(await put(base, id, sealed, "", headers)).status,
		409,
	);

	await admin(base, `/link/${id}`, { method: "DELETE" });
	check(
		"a revoked link is gone at once",
		(await open(base, id, gate)).status,
		404,
	);
	await put(base, id, sealed, "", headers);
	check("and takes a new one again", (await open(base, id, gate)).status, 200);
}

async function passphrase(base: string): Promise<void> {
	const id = newLinkId();
	const key = newLinkKey();
	const salt = newLinkSalt();
	const right = await deriveLinkKeys(key, {
		passphrase: "correct horse",
		salt,
	});
	const wrong = await deriveLinkKeys(key, { passphrase: "wrong horse", salt });
	const sealed = await sealLinkPayload(id, payload, right.content);
	await put(base, id, sealed, "?maxViews=1", {
		"X-Mdsync-Gate": right.gate ?? "",
		"X-Mdsync-Salt": toBase64Url(salt),
	});
	const meta = (await (await fetch(`${base}/link/${id}/meta`)).json()) as {
		protected: boolean;
		salt: string;
	};
	check(
		"the viewer is told to ask for a passphrase",
		[meta.protected, meta.salt],
		[true, toBase64Url(salt)],
	);
	check(
		"a wrong passphrase is refused",
		(await open(base, id, wrong.gate ?? "")).status,
		401,
	);
	check("a missing gate is refused", (await open(base, id)).status, 401);
	const opened = await open(base, id, right.gate ?? "");
	check(
		"the right one opens, the refusals having cost no view",
		opened.status,
		200,
	);
	const blob = new Uint8Array(await opened.arrayBuffer());
	check(
		"and decrypts with the same key and passphrase",
		await openLinkPayload(id, blob, right.content),
		payload,
	);

	const cooled = newLinkId();
	await put(base, cooled, sealed, "", {
		"X-Mdsync-Gate": right.gate ?? "",
		"X-Mdsync-Salt": toBase64Url(salt),
	});
	for (let i = 0; i < 5; i++) await open(base, cooled, wrong.gate ?? "");
	const locked = await open(base, cooled, right.gate ?? "");
	check(
		"five wrong guesses start a cooldown",
		[locked.status, locked.headers.get("Retry-After")],
		[429, "60"],
	);
}

async function update(base: string): Promise<void> {
	const id = newLinkId();
	const key = newLinkKey();
	const { content, gate } = await deriveLinkKeys(key);
	const first = await sealLinkPayload(id, payload, content);
	await put(base, id, first, "?maxViews=3", { "X-Mdsync-Gate": gate });
	await open(base, id, gate);
	const edited = { ...payload, html: "<p>Edited</p>" };
	await put(
		base,
		id,
		await sealLinkPayload(id, edited, content),
		"?update=1&maxViews=1&ttl=60",
		{ "X-Mdsync-Gate": gate },
	);
	const opened = await open(base, id, gate);
	check(
		"an update keeps the views already spent",
		opened.headers.get(VIEWS_LEFT),
		"1",
	);
	const blob = new Uint8Array(await opened.arrayBuffer());
	check(
		"and serves the new text",
		(await openLinkPayload(id, blob, content)).html,
		edited.html,
	);
}

async function expiry(base: string): Promise<void> {
	const id = newLinkId();
	const { sealed, gate } = await seal(id, newLinkKey());
	await put(base, id, sealed, "?ttl=2", { "X-Mdsync-Gate": gate });
	check(
		"a link opens before it expires",
		(await open(base, id, gate)).status,
		200,
	);
	await sleep(3_500);
	check("and is gone after", (await open(base, id, gate)).status, 404);
}

/** Past the Durable Object's 2 MB value limit, so the blob must be stored in chunks. */
async function bigNote(base: string): Promise<void> {
	const id = newLinkId();
	const { content, gate } = await deriveLinkKeys(newLinkKey());
	const noise = crypto.getRandomValues(new Uint8Array(65_536));
	const html = Array.from({ length: 90 }, () => toBase64Url(noise)).join("");
	const sealed = await sealLinkPayload(id, { ...payload, html }, content);
	check(
		"the note is several chunks long",
		sealed.length > 3 * 1024 * 1024,
		true,
	);
	await put(base, id, sealed, "", { "X-Mdsync-Gate": gate });
	const blob = new Uint8Array(await (await open(base, id, gate)).arrayBuffer());
	check(
		"a multi-chunk note comes back whole",
		(await openLinkPayload(id, blob, content)).html === html,
		true,
	);
	const tooBig = await put(
		base,
		newLinkId(),
		new Uint8Array(6 * 1024 * 1024 + 1),
		"",
		{ "X-Mdsync-Gate": gate },
	);
	check("a note past the cap is refused", tooBig.status, 413);
}

async function seal(id: string, key: Uint8Array) {
	const { content, gate } = await deriveLinkKeys(key);
	return {
		id,
		sealed: await sealLinkPayload(id, payload, content),
		content,
		gate,
	};
}
