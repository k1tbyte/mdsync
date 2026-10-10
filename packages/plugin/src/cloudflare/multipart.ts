import { toHex } from "@mdsync/protocol";

export interface FormPart {
	name: string;
	filename?: string;
	type: string;
	data: string;
}

export interface FormBody {
	contentType: string;
	body: ArrayBuffer;
}

/** `requestUrl` takes no FormData, so the body is assembled by hand. */
export function encodeForm(parts: readonly FormPart[]): FormBody {
	const boundary = `mdsync-${toHex(crypto.getRandomValues(new Uint8Array(16)))}`;
	const body = parts.map((part) => {
		const filename = part.filename ? `; filename="${part.filename}"` : "";
		return `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${filename}\r\nContent-Type: ${part.type}\r\n\r\n${part.data}\r\n`;
	});
	body.push(`--${boundary}--\r\n`);
	return {
		contentType: `multipart/form-data; boundary=${boundary}`,
		body: new TextEncoder().encode(body.join("")).buffer,
	};
}
