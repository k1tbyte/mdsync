import {
	type ClientFrame,
	decodeServer,
	EHubParam,
	encodeClient,
	HUB_PATH,
	KEEPALIVE_PING,
	type ServerFrame,
} from "@obsync/protocol";

const WAIT_MS = 20_000;

type FrameOf<T extends ServerFrame["type"]> = Extract<ServerFrame, { type: T }>;

export interface Peer {
	has(type: ServerFrame["type"]): boolean;
	send(frame: ClientFrame): void;
	ping(): void;
	next<T extends ServerFrame["type"]>(type: T): Promise<FrameOf<T>>;
	closeCode(): Promise<number>;
	isOpen(): boolean;
	close(): void;
}

export async function connectPeer(
	workerUrl: string,
	grants: readonly (readonly [channel: string, token: string])[],
	device: string,
): Promise<Peer> {
	const url = new URL(HUB_PATH, workerUrl.replace(/^http/, "ws"));
	for (const [channel, token] of grants) {
		url.searchParams.append(EHubParam.Channel, channel);
		url.searchParams.append(EHubParam.Token, token);
	}
	url.searchParams.set(EHubParam.Device, device);

	const socket = new WebSocket(url.href);
	socket.binaryType = "arraybuffer";
	const inbox: ServerFrame[] = [];
	const waiting = new Set<() => void>();
	let code: number | undefined;
	const wake = () => {
		for (const check of [...waiting]) check();
	};
	socket.addEventListener("message", ({ data }) => {
		if (typeof data === "string") return;
		const frame = decodeServer(new Uint8Array(data as ArrayBuffer));
		if (frame) inbox.push(frame);
		wake();
	});
	socket.addEventListener("close", (event) => {
		code = event.code;
		wake();
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () =>
			reject(new Error(`${device}: cannot reach ${url.origin}`)),
		);
	});

	const until = <T>(find: () => T | undefined, what: string) =>
		new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				waiting.delete(check);
				reject(new Error(`${device}: no ${what} within ${WAIT_MS} ms`));
			}, WAIT_MS);
			const check = () => {
				const found = find();
				if (found === undefined) return;
				clearTimeout(timer);
				waiting.delete(check);
				resolve(found);
			};
			waiting.add(check);
			check();
		});

	const next = <T extends ServerFrame["type"]>(type: T) =>
		until<FrameOf<T>>(() => {
			const at = inbox.findIndex((frame) => frame.type === type);
			return at < 0 ? undefined : (inbox.splice(at, 1)[0] as FrameOf<T>);
		}, `frame ${type}`);

	return {
		has: (type) => inbox.some((frame) => frame.type === type),
		send: (frame) => socket.send(encodeClient(frame)),
		ping: () => socket.send(KEEPALIVE_PING),
		next,
		closeCode: () => until(() => code, "close"),
		isOpen: () => socket.readyState === WebSocket.OPEN,
		close: () => socket.close(),
	};
}
