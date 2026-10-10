import { bytesToBase64 } from "@/utils";

import type { CloudflareApi } from "./api";
import type { RelayAsset } from "./bundle";
import { encodeForm } from "./multipart";

const encoder = new TextEncoder();

interface UploadSession {
	jwt: string;
	buckets?: string[][];
}

/** Returns the completion JWT the script upload attaches the files with. */
export async function uploadAssets(
	api: CloudflareApi,
	accountPath: string,
	scriptName: string,
	files: readonly RelayAsset[],
): Promise<string> {
	const manifest = Object.fromEntries(
		files.map((f) => [f.path, { hash: f.hash, size: f.size }]),
	);
	const session = await api.call<UploadSession>(
		"POST",
		`${accountPath}/workers/scripts/${scriptName}/assets-upload-session`,
		{ json: { manifest } },
	);
	// Nothing new to upload: the session token is already the completion token.
	if (!session.buckets?.length) return session.jwt;

	const byHash = new Map(files.map((f) => [f.hash, f]));
	let completion: string | undefined;
	for (const bucket of session.buckets) {
		const parts = bucket.map((hash) => {
			const file = byHash.get(hash);
			if (!file) throw new Error(`Cloudflare asked for unknown file ${hash}.`);
			return {
				name: hash,
				filename: hash,
				type: file.type,
				data: bytesToBase64(encoder.encode(file.text)),
			};
		});
		const result = await api.call<{ jwt?: string } | null>(
			"POST",
			`${accountPath}/workers/assets/upload?base64=true`,
			{ form: encodeForm(parts), bearer: session.jwt },
		);
		completion = result?.jwt ?? completion;
	}
	if (!completion)
		throw new Error("Cloudflare did not confirm the relay's files.");
	return completion;
}
