/**
 * Share links: a note's rendered HTML sealed so the relay holds only ciphertext. The plugin seals, the viewer
 * opens, the relay checks the gate; this file is the one definition of the format.
 */

import { fromBase64Url, toBase64Url } from "./bytes";

const subtle = crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Worker typings widen `encode` to `Uint8Array<ArrayBufferLike>`; a copy is always a plain ArrayBuffer. */
const utf8 = (text: string) => new Uint8Array(encoder.encode(text));

const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const LINK_KEY_BYTES = 16;
export const LINK_SALT_BYTES = 16;
export const LINK_GATE_BYTES = 32;
/** The gate as it travels: base64url of {@link LINK_GATE_BYTES}. */
export const LINK_GATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const LINK_MAX_SEALED_BYTES = 6 * 1024 * 1024;
export const LINK_MAX_VIEWS = 10_000;
export const LINK_MAX_TTL_S = 365 * 24 * 60 * 60;
export const LINK_KDF_ITERATIONS = 600_000;
/** Request headers the owner sends with a protected link; response headers of an open. */
export const LINK_HEADERS = {
	gate: "X-Mdsync-Gate",
	salt: "X-Mdsync-Salt",
	viewsLeft: "X-Mdsync-Views-Left",
	expires: "X-Mdsync-Expires",
} as const;
/** Deflate ratios reach 1000x; an opened payload past this is refused, not inflated, so none is sealed. */
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;

const SEAL_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CONTENT_INFO = "mdsync-link-content-v1";
const GATE_INFO = "mdsync-link-gate-v1";

export interface LinkPayload {
	title: string;
	html: string;
	createdAt: number;
}

/** What anyone may ask of a link before opening it: `GET /link/<id>/meta`. */
export interface LinkMeta {
	protected: boolean;
	salt: string | null;
}

/** Where a link stands, for its owner: `GET /link/<id>/status`. */
export interface LinkStatus {
	views: number;
	maxViews: number | null;
	expires: number | null;
	protected: boolean;
	size: number;
}

/** A creation never inherits a counter; only an update, which needs a link still standing, keeps one. */
export type LinkPutMode = "create" | "update";

export interface LinkProtection {
	passphrase: string;
	salt: Uint8Array;
}

export interface LinkKeys {
	content: CryptoKey;
	/** What the relay checks before it serves or updates a link; the fragment key alone makes it when unprotected. */
	gate: string;
}

export function isLinkId(id: string): boolean {
	return LINK_ID_PATTERN.test(id);
}

export function newLinkId(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export function newLinkKey(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(LINK_KEY_BYTES));
}

export function newLinkSalt(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(LINK_SALT_BYTES));
}

/**
 * The key from the URL fragment, plus the stretched passphrase when there is one, feeds both outputs: without
 * the fragment the relay cannot test a passphrase guess, even offline, and an id alone opens nothing.
 */
export async function deriveLinkKeys(
	key: Uint8Array,
	protection?: LinkProtection,
): Promise<LinkKeys> {
	const stretched = protection ? await stretch(protection) : new Uint8Array(0);
	const material = new Uint8Array(key.length + stretched.length);
	material.set(key);
	material.set(stretched, key.length);
	const base = await subtle.importKey("raw", material, "HKDF", false, [
		"deriveKey",
		"deriveBits",
	]);
	const content = await subtle.deriveKey(
		hkdf(CONTENT_INFO),
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
	const gate = await subtle.deriveBits(
		hkdf(GATE_INFO),
		base,
		LINK_GATE_BYTES * 8,
	);
	return { content, gate: toBase64Url(new Uint8Array(gate)) };
}

export async function sealLinkPayload(
	id: string,
	payload: LinkPayload,
	content: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
	const plain = utf8(JSON.stringify(payload));
	if (plain.length > MAX_PLAINTEXT_BYTES) {
		throw new RangeError("This note is too large to open once shared.");
	}
	const packed = await transform(
		plain,
		new CompressionStream("deflate"),
		Number.POSITIVE_INFINITY,
	);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = await subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: aad(id) },
		content,
		packed,
	);
	const out = new Uint8Array(1 + IV_BYTES + sealed.byteLength);
	out[0] = SEAL_VERSION;
	out.set(iv, 1);
	out.set(new Uint8Array(sealed), 1 + IV_BYTES);
	return out;
}

/** Throws one error for a wrong key, a bad blob and a malformed payload alike. */
export async function openLinkPayload(
	id: string,
	sealed: Uint8Array,
	content: CryptoKey,
): Promise<LinkPayload> {
	try {
		if (
			sealed.length < 1 + IV_BYTES + TAG_BYTES ||
			sealed[0] !== SEAL_VERSION
		) {
			throw new Error("not a link blob");
		}
		const packed = await subtle.decrypt(
			{
				name: "AES-GCM",
				iv: sealed.slice(1, 1 + IV_BYTES),
				additionalData: aad(id),
			},
			content,
			sealed.slice(1 + IV_BYTES),
		);
		const text = await transform(
			new Uint8Array(packed),
			new DecompressionStream("deflate"),
			MAX_PLAINTEXT_BYTES,
		);
		return payloadOf(JSON.parse(decoder.decode(text)));
	} catch {
		throw new Error("This link cannot be opened.");
	}
}

/**
 * `<relay>/s/<id>#<key>[/<anchor>]`: everything after the `#` stays in the browser. The anchor names a place in
 * the note; base64url has no `/`, so it cannot be mistaken for the key.
 */
export function linkUrl(
	relay: string,
	id: string,
	key: Uint8Array,
	anchor?: string,
): string {
	const place = anchor ? `/${encodeURIComponent(anchor)}` : "";
	return `${relay.replace(/\/+$/, "")}/s/${id}#${toBase64Url(key)}${place}`;
}

/** Reads a link's id from the path, its key and anchor from the fragment; null for anything else. */
export function parseLinkLocation(
	pathname: string,
	hash: string,
): { id: string; key: Uint8Array; anchor: string | null } | null {
	const id = /^\/s\/([^/]+)\/?$/.exec(pathname)?.[1];
	if (!id || !isLinkId(id)) return null;
	const [encodedKey = "", ...place] = hash.replace(/^#/, "").split("/");
	try {
		const key = fromBase64Url(encodedKey);
		if (key.length !== LINK_KEY_BYTES) return null;
		return { id, key, anchor: decodeAnchor(place.join("/")) };
	} catch {
		return null;
	}
}

/** A mistyped `%` leaves the anchor as typed rather than losing the key with it. */
function decodeAnchor(encoded: string): string | null {
	if (!encoded) return null;
	try {
		return decodeURIComponent(encoded);
	} catch {
		return encoded;
	}
}

async function stretch({
	passphrase,
	salt,
}: LinkProtection): Promise<Uint8Array> {
	// One passphrase typed on two systems may differ in Unicode form or stray spaces from pasting.
	const base = await subtle.importKey(
		"raw",
		utf8(passphrase.trim().normalize("NFC")),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await subtle.deriveBits(
		{
			name: "PBKDF2",
			salt: new Uint8Array(salt),
			iterations: LINK_KDF_ITERATIONS,
			hash: "SHA-256",
		},
		base,
		256,
	);
	return new Uint8Array(bits);
}

function hkdf(info: string) {
	return {
		name: "HKDF" as const,
		hash: "SHA-256" as const,
		salt: new Uint8Array(0),
		info: utf8(info),
	};
}

/** Binds a blob to its link, so the relay cannot serve one link's note under another's id. */
function aad(id: string): Uint8Array<ArrayBuffer> {
	return utf8(`link:${id}`);
}

function payloadOf(value: unknown): LinkPayload {
	const { title, html, createdAt } = (value ?? {}) as Partial<LinkPayload>;
	if (
		typeof title !== "string" ||
		typeof html !== "string" ||
		typeof createdAt !== "number"
	) {
		throw new Error("malformed payload");
	}
	return { title, html, createdAt };
}

/** Runs bytes through a (de)compression stream, stopping once the output passes `limit`. */
async function transform(
	input: Uint8Array<ArrayBuffer>,
	stream: CompressionStream | DecompressionStream,
	limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const writer = stream.writable.getWriter();
	// A bomb makes the write reject once the reader quits; the refusal below reports it.
	void writer
		.write(input)
		.then(() => writer.close())
		.catch(() => undefined);
	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > limit) {
			await reader.cancel();
			throw new Error("payload too large");
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}
