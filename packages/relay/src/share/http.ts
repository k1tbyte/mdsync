/** Response and request helpers shared by the broker's participant and owner routes. */

export type JsonObject = Record<string, unknown>;

const JSON_HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function jsonError(
	status: number,
	code: string,
	message: string,
): Response {
	return json({ error: code, message }, status);
}

export function badRequest(message: string): Response {
	return jsonError(400, "bad_request", message);
}

export function adminUnauthorized(): Response {
	return jsonError(401, "unauthorized", "Invalid relay secret");
}

export function methodNotAllowed(allow: string): Response {
	const response = jsonError(405, "method_not_allowed", `Allowed: ${allow}`);
	response.headers.set("Allow", allow);
	return response;
}

/** Empty when the header is absent or not a bearer token. */
export function bearerOf(request: Request): string {
	const header = request.headers.get("Authorization") ?? "";
	if (!header.startsWith("Bearer ")) return "";
	return header.slice("Bearer ".length).trim();
}

/** With `maxBytes`, a larger body is dropped unread rather than buffered whole: null, like any bad body. */
export async function readJsonObject(
	request: Request,
	maxBytes?: number,
): Promise<JsonObject | null> {
	try {
		const text =
			maxBytes === undefined
				? await request.text()
				: await boundedText(request, maxBytes);
		// `null` is valid JSON, so the shape has to be checked before it is read.
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" ? (parsed as JsonObject) : null;
	} catch {
		return null;
	}
}

/** A chunked body carries no length to trust, so the bytes are counted as they arrive. */
async function boundedText(
	request: Request,
	maxBytes: number,
): Promise<string> {
	if (Number(request.headers.get("Content-Length")) > maxBytes) {
		throw new RangeError("Body too large");
	}
	if (!request.body) return "";
	let total = 0;
	const counted = request.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				total += chunk.length;
				if (total > maxBytes)
					controller.error(new RangeError("Body too large"));
				else controller.enqueue(chunk);
			},
		}),
	);
	return new Response(counted).text();
}
