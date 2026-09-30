/** Owner-side broker routes: registering a share's storage and managing its participants, all behind the relay secret. */

import { shareChannel } from "@obsync/protocol";
import { hubStub } from "../hub/durable-object";
import { isAdmin } from "../secret";
import {
	adminUnauthorized,
	badRequest,
	type JsonObject,
	json,
	readJsonObject,
} from "./http";
import { isShareId } from "./key";
import {
	EShareRole,
	listParticipants,
	revokeParticipant,
	revokeShare,
	type ShareEnv,
	type ShareStorage,
	saveStorage,
	saveToken,
} from "./kv";

/** Rides in each hub socket's 16 KB attachment as `who`. */
const MAX_PARTICIPANT_ID_LENGTH = 64;
const REQUIRED_STORAGE_FIELDS = [
	"endpoint",
	"bucket",
	"accessKeyId",
	"secretAccessKey",
] as const;

export async function registerShare(
	request: Request,
	env: ShareEnv,
	shareId: string,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	if (!isShareId(shareId)) return badRequest("Invalid shareId");
	const storage = readShareStorage(await readJsonObject(request));
	if (!storage) return badRequest("Invalid share storage");
	await saveStorage(env, shareId, storage);
	return json({ registered: true });
}

export async function endShare(
	request: Request,
	env: ShareEnv,
	shareId: string,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	if (!isShareId(shareId)) return badRequest("Invalid shareId");
	const revoked = await revokeShare(env, shareId);
	await hubStub(env).purgeChannel(shareChannel(shareId));
	return json({ revoked });
}

export async function issueToken(
	request: Request,
	env: ShareEnv,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	const body = await readJsonObject(request);
	if (!body) return badRequest("Invalid JSON body");
	const { shareId, participantId } = body;
	if (typeof shareId !== "string" || typeof participantId !== "string") {
		return badRequest("shareId and participantId required");
	}
	if (
		!participantId ||
		participantId.length > MAX_PARTICIPANT_ID_LENGTH ||
		!isShareId(shareId)
	) {
		return badRequest("Invalid shareId or participantId");
	}
	return json(
		await saveToken(env, {
			shareId,
			participantId,
			role:
				body.role === EShareRole.ReadOnly
					? EShareRole.ReadOnly
					: EShareRole.ReadWrite,
			label: typeof body.label === "string" ? body.label : undefined,
		}),
	);
}

export async function listTokens(
	request: Request,
	env: ShareEnv,
	shareId: string,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	if (!isShareId(shareId)) return badRequest("Invalid shareId");
	return json({ participants: await listParticipants(env, shareId) });
}

export async function revokeToken(
	request: Request,
	env: ShareEnv,
	encodedParticipantId: string,
	shareId: string,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	let participantId: string;
	try {
		participantId = decodeURIComponent(encodedParticipantId);
	} catch {
		return badRequest("Invalid participantId");
	}
	if (!participantId || !isShareId(shareId)) {
		return badRequest("Valid shareId and participantId required");
	}
	return json({
		revoked: await revokeParticipant(env, shareId, participantId),
	});
}

/** Extra fields are dropped, so a registration stores exactly what signing reads. */
function readShareStorage(body: JsonObject | null): ShareStorage | null {
	if (!body) return null;
	for (const field of REQUIRED_STORAGE_FIELDS) {
		if (typeof body[field] !== "string" || !body[field]) return null;
	}
	if (typeof body.region !== "string" || typeof body.prefix !== "string") {
		return null;
	}
	if (typeof body.forcePathStyle !== "boolean") return null;
	if (!URL.canParse(body.endpoint as string)) return null;
	return {
		endpoint: body.endpoint as string,
		region: body.region || "auto",
		bucket: body.bucket as string,
		prefix: body.prefix,
		accessKeyId: body.accessKeyId as string,
		secretAccessKey: body.secretAccessKey as string,
		forcePathStyle: body.forcePathStyle,
	};
}
