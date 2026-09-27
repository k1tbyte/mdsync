/** Password-sealed payloads in obsidian:// links: settings transfers and share invites. */

import { base64UrlToBytes, bytesToBase64Url } from "@/utils/base64";
import { deflateBytes, inflateBytes } from "@/utils/compress";

import { decryptBytes, deriveKey, encryptBytes, randomBytes } from "./index";

const LINK_VERSION = 5;
const LINK_SALT_BYTES = 16;
const LINK_PARTS = 4;
export const LINK_PARAM = "d";

const ELinkEncoding = {
	Plain: "p",
	Deflate: "z",
} as const;
type ELinkEncoding = (typeof ELinkEncoding)[keyof typeof ELinkEncoding];

const LINK_ENCODINGS: Readonly<Record<string, ELinkEncoding>> = {
	[ELinkEncoding.Plain]: ELinkEncoding.Plain,
	[ELinkEncoding.Deflate]: ELinkEncoding.Deflate,
};

export async function sealLink(
	plaintext: Uint8Array,
	passphrase: string,
): Promise<string> {
	const salt = randomBytes(LINK_SALT_BYTES);
	const key = await deriveKey(passphrase, salt);
	const encoded = await encodeLinkBytes(plaintext);
	const ciphertext = await encryptBytes(key, encoded.bytes);
	return [
		String(LINK_VERSION),
		encoded.encoding,
		bytesToBase64Url(salt),
		bytesToBase64Url(ciphertext),
	].join(".");
}

export async function openLink(
	input: string,
	passphrase: string,
): Promise<Uint8Array> {
	const parsed = parseLinkToken(extractLinkToken(input));
	const key = await deriveKey(passphrase, parsed.salt);
	const encoded = await decryptBytes(key, parsed.ciphertext);
	return decodeLinkBytes(parsed.encoding, encoded);
}

async function encodeLinkBytes(
	plaintext: Uint8Array,
): Promise<{ bytes: Uint8Array; encoding: ELinkEncoding }> {
	const compressed = await deflateBytes(plaintext);
	if (compressed === null || compressed.length >= plaintext.length) {
		return { bytes: plaintext, encoding: ELinkEncoding.Plain };
	}
	return { bytes: compressed, encoding: ELinkEncoding.Deflate };
}

async function decodeLinkBytes(
	encoding: ELinkEncoding,
	bytes: Uint8Array,
): Promise<Uint8Array> {
	if (encoding === ELinkEncoding.Plain) return bytes;
	return inflateBytes(bytes);
}

function parseLinkToken(token: string): {
	encoding: ELinkEncoding;
	salt: Uint8Array;
	ciphertext: Uint8Array;
} {
	const parts = token.split(".");
	if (parts.length !== LINK_PARTS) {
		throw new Error("Invalid Obsync link");
	}
	const [versionText, encodingText, saltText, ciphertextText] = parts as [
		string,
		string,
		string,
		string,
	];
	const version = Number.parseInt(versionText, 10);
	if (version !== LINK_VERSION) {
		throw new Error("Unsupported Obsync link");
	}
	const encoding = LINK_ENCODINGS[encodingText];
	if (!encoding) {
		throw new Error("Unsupported Obsync link encoding");
	}
	const salt = base64UrlToBytes(saltText);
	if (salt.length !== LINK_SALT_BYTES) {
		throw new Error("Invalid Obsync link");
	}
	return {
		encoding,
		salt,
		ciphertext: base64UrlToBytes(ciphertextText),
	};
}

function extractLinkToken(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("The link is empty");
	// A bare token is accepted as well as the full link.
	try {
		return new URL(trimmed).searchParams.get(LINK_PARAM) || trimmed;
	} catch {
		return trimmed;
	}
}
