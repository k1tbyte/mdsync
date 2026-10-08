import { describe, expect, it } from "vitest";

import {
	deriveLinkKeys,
	fromBase64Url,
	isLinkId,
	LINK_GATE_PATTERN,
	LINK_KEY_BYTES,
	type LinkPayload,
	linkUrl,
	newLinkId,
	newLinkKey,
	newLinkSalt,
	openLinkPayload,
	parseLinkLocation,
	sealLinkPayload,
	toBase64Url,
} from "../src/index";

const payload: LinkPayload = {
	title: "Trip notes",
	html: "<p>Lisbon in <b>May</b> ✈</p>".repeat(50),
	createdAt: 1_760_000_000_000,
};
const bomb = { ...payload, html: "a".repeat(40 * 1024 * 1024) };

describe("base64url", () => {
	it("round-trips bytes of every length", () => {
		for (let length = 0; length < 40; length++) {
			const bytes = crypto.getRandomValues(new Uint8Array(length));
			expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
		}
	});

	it("refuses text that is not base64url", () => {
		expect(() => fromBase64Url("ab+/")).toThrow();
		expect(() => fromBase64Url("a b")).toThrow();
	});
});

describe("link ids", () => {
	it("accepts what newLinkId makes and nothing else", () => {
		expect(isLinkId(newLinkId())).toBe(true);
		expect(isLinkId("short")).toBe(false);
		expect(isLinkId(`${newLinkId()}x`)).toBe(false);
		expect(isLinkId("../".repeat(8))).toBe(false);
	});
});

describe("seal and open", () => {
	it("round-trips a payload", async () => {
		const id = newLinkId();
		const { content } = await deriveLinkKeys(newLinkKey());
		const sealed = await sealLinkPayload(id, payload, content);
		expect(await openLinkPayload(id, sealed, content)).toEqual(payload);
	});

	it("compresses repeated markup", async () => {
		const { content } = await deriveLinkKeys(newLinkKey());
		const sealed = await sealLinkPayload(newLinkId(), payload, content);
		expect(sealed.length).toBeLessThan(payload.html.length / 4);
	});

	it("seals the same payload differently each time", async () => {
		const id = newLinkId();
		const { content } = await deriveLinkKeys(newLinkKey());
		const [a, b] = await Promise.all([
			sealLinkPayload(id, payload, content),
			sealLinkPayload(id, payload, content),
		]);
		expect(a).not.toEqual(b);
	});

	it("refuses a different key", async () => {
		const id = newLinkId();
		const sealed = await sealLinkPayload(
			id,
			payload,
			(await deriveLinkKeys(newLinkKey())).content,
		);
		const other = (await deriveLinkKeys(newLinkKey())).content;
		await expect(openLinkPayload(id, sealed, other)).rejects.toThrow();
	});

	it("refuses the blob under another link's id", async () => {
		const { content } = await deriveLinkKeys(newLinkKey());
		const sealed = await sealLinkPayload(newLinkId(), payload, content);
		await expect(
			openLinkPayload(newLinkId(), sealed, content),
		).rejects.toThrow();
	});

	it("refuses a tampered or truncated blob", async () => {
		const id = newLinkId();
		const { content } = await deriveLinkKeys(newLinkKey());
		const sealed = await sealLinkPayload(id, payload, content);
		const flipped = sealed.slice();
		flipped.set([(flipped.at(-1) ?? 0) ^ 1], flipped.length - 1);
		await expect(openLinkPayload(id, flipped, content)).rejects.toThrow();
		await expect(
			openLinkPayload(id, sealed.slice(0, 20), content),
		).rejects.toThrow();
		const relabelled = sealed.slice();
		relabelled[0] = 2;
		await expect(openLinkPayload(id, relabelled, content)).rejects.toThrow();
	});

	it("refuses to seal a payload too large to open", async () => {
		const { content } = await deriveLinkKeys(newLinkKey());
		await expect(
			sealLinkPayload(newLinkId(), bomb, content),
		).rejects.toBeInstanceOf(RangeError);
	});

	it("refuses a payload that inflates past the limit", async () => {
		const id = newLinkId();
		const { content } = await deriveLinkKeys(newLinkKey());
		const sealed = await sealByHand(id, bomb, content);
		expect(sealed.length).toBeLessThan(1024 * 1024);
		await expect(openLinkPayload(id, sealed, content)).rejects.toThrow();
	});
});

describe("passphrase", () => {
	const protection = (passphrase: string, salt = newLinkSalt()) => ({
		passphrase,
		salt,
	});

	it("derives the gate from key, passphrase and salt", async () => {
		const key = newLinkKey();
		const salt = newLinkSalt();
		const a = await deriveLinkKeys(key, protection("correct horse", salt));
		const same = await deriveLinkKeys(key, protection("correct horse", salt));
		expect(a.gate).toMatch(LINK_GATE_PATTERN);
		expect(same.gate).toBe(a.gate);
		const gates = await Promise.all([
			deriveLinkKeys(key, protection("wrong horse", salt)),
			deriveLinkKeys(newLinkKey(), protection("correct horse", salt)),
			deriveLinkKeys(key, protection("correct horse")),
		]);
		for (const other of gates) expect(other.gate).not.toBe(a.gate);
	});

	it("has no gate without a passphrase", async () => {
		expect((await deriveLinkKeys(newLinkKey())).gate).toBeNull();
	});

	it("opens only with the same key and passphrase", async () => {
		const id = newLinkId();
		const key = newLinkKey();
		const salt = newLinkSalt();
		const sealed = await sealLinkPayload(
			id,
			payload,
			(await deriveLinkKeys(key, protection("correct horse", salt))).content,
		);
		const right = await deriveLinkKeys(key, protection("correct horse", salt));
		expect(await openLinkPayload(id, sealed, right.content)).toEqual(payload);
		for (const wrong of [
			await deriveLinkKeys(key, protection("wrong horse", salt)),
			await deriveLinkKeys(key),
		]) {
			await expect(
				openLinkPayload(id, sealed, wrong.content),
			).rejects.toThrow();
		}
	});

	it("treats Unicode forms of one passphrase alike", async () => {
		const key = newLinkKey();
		const salt = newLinkSalt();
		const composed = await deriveLinkKeys(
			key,
			protection("caf\u00e9 au lait", salt),
		);
		const decomposed = await deriveLinkKeys(
			key,
			protection("cafe\u0301 au lait", salt),
		);
		expect(decomposed.gate).toBe(composed.gate);
	});
});

describe("link url", () => {
	it("carries the key in the fragment and parses back", () => {
		const id = newLinkId();
		const key = newLinkKey();
		const url = new URL(linkUrl("https://relay.example.com//", id, key));
		expect(url.pathname).toBe(`/s/${id}`);
		expect(url.search).toBe("");
		expect(parseLinkLocation(url.pathname, url.hash)).toEqual({
			id,
			key,
			anchor: null,
		});
	});

	it("carries an anchor after the key", () => {
		const id = newLinkId();
		const key = newLinkKey();
		const url = new URL(
			linkUrl("https://relay.example.com", id, key, "été 1/plan"),
		);
		expect(url.hash).toBe(
			`#${toBase64Url(key)}/${encodeURIComponent("été 1/plan")}`,
		);
		expect(parseLinkLocation(url.pathname, url.hash)).toEqual({
			id,
			key,
			anchor: "été 1/plan",
		});
		expect(
			parseLinkLocation(url.pathname, `#${toBase64Url(key)}/100%`)?.anchor,
		).toBe("100%");
		expect(
			parseLinkLocation(url.pathname, `#${toBase64Url(key)}/`)?.anchor,
		).toBeNull();
	});

	it("rejects a path or key that does not fit", () => {
		const id = newLinkId();
		const key = toBase64Url(newLinkKey());
		expect(parseLinkLocation("/s/short", `#${key}`)).toBeNull();
		expect(parseLinkLocation(`/x/${id}`, `#${key}`)).toBeNull();
		expect(parseLinkLocation(`/s/${id}`, "")).toBeNull();
		expect(parseLinkLocation(`/s/${id}`, `#${key}AA`)).toBeNull();
		expect(parseLinkLocation(`/s/${id}`, "#!!")).toBeNull();
		expect(newLinkKey()).toHaveLength(LINK_KEY_BYTES);
	});
});

/** Seals past the size cap, as a hostile relay or an old plugin could. */
async function sealByHand(id: string, value: LinkPayload, key: CryptoKey) {
	const json = new Blob([JSON.stringify(value)]).stream();
	const packed = await new Response(
		json.pipeThrough(new CompressionStream("deflate")),
	).arrayBuffer();
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const additionalData = new TextEncoder().encode(`link:${id}`);
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData },
		key,
		packed,
	);
	return new Uint8Array([1, ...iv, ...new Uint8Array(sealed)]);
}
