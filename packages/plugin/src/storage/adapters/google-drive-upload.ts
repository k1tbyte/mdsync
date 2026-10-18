import { toArrayBuffer } from "@/utils";
import { type AuthorizedRequest, driveRequest } from "./google-drive-request";
import { assertOk } from "./util";

const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
/** Multipart max; larger files go resumable. */
const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;
const MULTIPART_BOUNDARY = "-------314159265358979323846";

function getUploadTarget(
	key: string,
	existingId: string | null,
	folderId: string,
	uploadType: string,
) {
	const metadata = {
		name: key,
		...(existingId ? {} : { parents: [folderId] }),
	};
	return {
		url: `${DRIVE_UPLOAD_API}${existingId ? `/${existingId}` : ""}?uploadType=${uploadType}`,
		method: existingId ? "PATCH" : "POST",
		metadata,
	} as const;
}

async function multipartUpload(
	key: string,
	body: Uint8Array,
	contentType: string | undefined,
	existingId: string | null,
	authorized: AuthorizedRequest,
	context: { folderId: string },
): Promise<string | null> {
	const target = getUploadTarget(
		key,
		existingId,
		context.folderId,
		"multipart",
	);
	const delimiter = `\r\n--${MULTIPART_BOUNDARY}\r\n`;
	const closeDelim = `\r\n--${MULTIPART_BOUNDARY}--`;
	const metadataPart = `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(target.metadata)}`;
	const mediaPart = `Content-Type: ${contentType ?? "application/octet-stream"}\r\n\r\n`;

	const encoder = new TextEncoder();
	const top = encoder.encode(delimiter + metadataPart + delimiter + mediaPart);
	const bottom = encoder.encode(closeDelim);
	const payload = new Uint8Array(top.length + body.length + bottom.length);
	payload.set(top, 0);
	payload.set(body, top.length);
	payload.set(bottom, top.length + body.length);

	const res = await authorized({
		url: target.url,
		method: target.method,
		headers: {
			"Content-Type": `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
		},
		body: toArrayBuffer(payload),
	});
	assertOk(res, "upload", key);
	return existingId ?? (res.json as { id?: string } | null)?.id ?? null;
}

async function resumableUpload(
	key: string,
	body: Uint8Array,
	contentType: string | undefined,
	existingId: string | null,
	authorized: AuthorizedRequest,
	context: { folderId: string },
): Promise<string | null> {
	const target = getUploadTarget(
		key,
		existingId,
		context.folderId,
		"resumable",
	);
	const start = await authorized({
		url: target.url,
		method: target.method,
		headers: {
			"X-Upload-Content-Type": contentType ?? "application/octet-stream",
		},
		body: JSON.stringify(target.metadata),
	});
	assertOk(start, "start upload of", key);
	const session = start.headers.location ?? start.headers.Location;
	if (!session) {
		throw new Error(`Google Drive did not open an upload session for "${key}"`);
	}

	let offset = 0;
	while (offset < body.length) {
		const end = Math.min(offset + RESUMABLE_CHUNK_BYTES, body.length);
		const chunk = body.subarray(offset, end);
		const res = await driveRequest({
			url: session,
			method: "PUT",
			headers: {
				"Content-Range": `bytes ${offset}-${end - 1}/${body.length}`,
			},
			body: toArrayBuffer(chunk),
			throw: false,
		});
		// 308 means "chunk stored, send the next one".
		if (res.status === 308) {
			offset = end;
			continue;
		}
		assertOk(res, "upload", key);
		return existingId ?? (res.json as { id?: string } | null)?.id ?? null;
	}
	return existingId;
}

/** Writes `body` as `key`, into `existingId` when it has one; the file's id, when Drive names it. */
export function sendUpload(
	key: string,
	body: Uint8Array,
	contentType: string | undefined,
	existingId: string | null,
	authorized: AuthorizedRequest,
	context: { folderId: string },
): Promise<string | null> {
	const send =
		body.length > MULTIPART_MAX_BYTES ? resumableUpload : multipartUpload;
	return send(key, body, contentType, existingId, authorized, context);
}
