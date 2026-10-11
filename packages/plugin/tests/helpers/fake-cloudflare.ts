import {
	type CloudflareApi,
	cloudflareApi,
	type HttpRequest,
} from "@/cloudflare";

const BASE = "https://api.cloudflare.com/client/v4";

export interface Reply {
	status?: number;
	result?: unknown;
	errors?: Array<{ code: number; message: string }>;
}

export interface Route {
	method: HttpRequest["method"];
	path: string | RegExp;
	reply: (request: HttpRequest) => Reply;
}

export interface FakeCloudflare {
	api: CloudflareApi;
	calls: HttpRequest[];
	/** Path without the API base, query included. */
	paths: () => string[];
}

export function fakeCloudflare(routes: Route[], token = "tok"): FakeCloudflare {
	const calls: HttpRequest[] = [];
	const api = cloudflareApi(async (request) => {
		calls.push(request);
		const path = request.url.slice(BASE.length);
		const route = routes.find(
			(r) =>
				r.method === request.method &&
				(typeof r.path === "string" ? r.path === path : r.path.test(path)),
		);
		const reply: Reply = route?.reply(request) ?? {
			status: 404,
			errors: [{ code: 0, message: `no route ${request.method} ${path}` }],
		};
		return {
			status: reply.status ?? 200,
			text: JSON.stringify({
				success: !reply.errors,
				result: reply.result ?? null,
				errors: reply.errors ?? [],
			}),
		};
	}, token);
	return {
		api,
		calls,
		paths: () => calls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`),
	};
}

export function failure(code: number, status = 400): Reply {
	return { status, errors: [{ code, message: `error ${code}` }] };
}

export async function readForm(request: HttpRequest): Promise<FormData> {
	return new Response(request.body, {
		headers: { "content-type": request.headers["Content-Type"] ?? "" },
	}).formData();
}
