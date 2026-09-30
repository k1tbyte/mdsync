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

export async function readJsonObject(
	request: Request,
): Promise<JsonObject | null> {
	try {
		// `null` is valid JSON, so the shape has to be checked before it is read.
		const parsed: unknown = await request.json();
		return parsed && typeof parsed === "object" ? (parsed as JsonObject) : null;
	} catch {
		return null;
	}
}
