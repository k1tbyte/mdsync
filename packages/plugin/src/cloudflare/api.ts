import type { FormBody } from "./multipart";

/** Injected so one flow runs over Obsidian's `requestUrl` and Node's `fetch`. */
export interface HttpRequest {
	url: string;
	method: "GET" | "POST" | "PUT" | "DELETE";
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
}

export interface HttpResponse {
	status: number;
	text: string;
}

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

const API_BASE = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
	success?: boolean;
	result?: T;
	errors?: ReadonlyArray<{ code: number; message: string }>;
}

export class CloudflareError extends Error {
	constructor(
		readonly status: number,
		readonly codes: readonly number[],
		message: string,
	) {
		super(message);
		this.name = "CloudflareError";
	}
}

export interface CallOptions {
	json?: unknown;
	form?: FormBody;
	/** Overrides the API token, e.g. with an asset upload session JWT. */
	bearer?: string;
}

export interface CloudflareApi {
	readonly token: string;
	call<T>(
		method: HttpRequest["method"],
		path: string,
		options?: CallOptions,
	): Promise<T>;
}

export function cloudflareApi(http: Http, token: string): CloudflareApi {
	return {
		token,
		async call<T>(
			method: HttpRequest["method"],
			path: string,
			options: CallOptions = {},
		): Promise<T> {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${options.bearer ?? token}`,
			};
			let body: string | ArrayBuffer | undefined;
			if (options.form) {
				headers["Content-Type"] = options.form.contentType;
				body = options.form.body;
			} else if (options.json !== undefined) {
				headers["Content-Type"] = "application/json";
				body = JSON.stringify(options.json);
			}
			const res = await http({
				url: `${API_BASE}${path}`,
				method,
				headers,
				body,
			});
			const envelope = parseEnvelope<T>(res.text);
			if (res.status >= 400 || envelope?.success === false) {
				const errors = envelope?.errors ?? [];
				const detail = errors.map((e) => `${e.message} (${e.code})`).join("; ");
				throw new CloudflareError(
					res.status,
					errors.map((e) => e.code),
					`Cloudflare ${method} ${path}: ${detail || `HTTP ${res.status}`}`,
				);
			}
			return envelope?.result as T;
		},
	};
}

function parseEnvelope<T>(text: string): Envelope<T> | null {
	try {
		return JSON.parse(text) as Envelope<T>;
	} catch {
		return null;
	}
}

export function hasCode(err: unknown, code: number): boolean {
	return err instanceof CloudflareError && err.codes.includes(code);
}
