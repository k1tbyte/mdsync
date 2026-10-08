const encoder = new TextEncoder();
/** Fatal and BOM-keeping, so decoded text re-encodes to the bytes it came from. */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_TEXT_BYTES = 255;

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
	return [...new Uint8Array(bytes)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Sealed notes run to megabytes; spreading one into `fromCharCode` would overflow the stack. */
const BASE64_CHUNK = 0x8000;

export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (let at = 0; at < bytes.length; at += BASE64_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(at, at + BASE64_CHUNK));
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** Throws on anything that is not base64url. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("invalid base64url");
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export class Writer {
	private readonly parts: Uint8Array[] = [];
	private length = 0;

	u8(value: number): this {
		return this.bytes(Uint8Array.of(value));
	}

	u32(value: number): this {
		const out = new Uint8Array(4);
		new DataView(out.buffer).setUint32(0, value);
		return this.bytes(out);
	}

	bytes(value: Uint8Array): this {
		this.parts.push(value);
		this.length += value.length;
		return this;
	}

	block(value: Uint8Array): this {
		return this.u32(value.length).bytes(value);
	}

	text(value: string): this {
		const bytes = encoder.encode(value);
		if (bytes.length > MAX_TEXT_BYTES) throw new Error("text field too long");
		return this.u8(bytes.length).bytes(bytes);
	}

	finish(): Uint8Array<ArrayBuffer> {
		const out = new Uint8Array(this.length);
		let at = 0;
		for (const part of this.parts) {
			out.set(part, at);
			at += part.length;
		}
		return out;
	}
}

/** Throws on truncation; the codec turns that into a rejected frame. */
export class Reader {
	private at = 0;
	private readonly source: Uint8Array;
	private readonly view: DataView;

	constructor(source: Uint8Array) {
		this.source = source;
		this.view = new DataView(
			source.buffer,
			source.byteOffset,
			source.byteLength,
		);
	}

	u8(): number {
		return this.view.getUint8(this.at++);
	}

	u32(): number {
		const value = this.view.getUint32(this.at);
		this.at += 4;
		return value;
	}

	block(): Uint8Array {
		return this.take(this.u32());
	}

	text(): string {
		return decoder.decode(this.take(this.u8()));
	}

	rest(): Uint8Array {
		return this.take(this.source.length - this.at);
	}

	/** Whether anything is left: a field added last is absent from an older writer's frames. */
	more(): boolean {
		return this.at < this.source.length;
	}

	private take(length: number): Uint8Array {
		if (this.at + length > this.source.length)
			throw new Error("truncated frame");
		const value = this.source.subarray(this.at, this.at + length);
		this.at += length;
		return value;
	}
}
