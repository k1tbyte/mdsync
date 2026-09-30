/** Node stand-in for Obsidian's `requestUrl`, the one thing the storage adapters need from it. */

interface RequestOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}

export async function requestUrl(request: RequestOptions) {
	const res = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		body: request.body,
	});
	const arrayBuffer = await res.arrayBuffer();
	const text = () => new TextDecoder().decode(arrayBuffer);
	return {
		status: res.status,
		headers: Object.fromEntries(res.headers),
		arrayBuffer,
		get text() {
			return text();
		},
		get json(): Record<string, unknown> {
			return JSON.parse(text());
		},
	};
}
