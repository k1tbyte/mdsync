import { UNAUTHORIZED_CLOSE_CODE } from "@mdsync/protocol";

import type { Hub } from "./durable-object";

/** A deployment is one trust domain, so one hub serves all of it. */
const HUB_NAME = "hub";

export interface HubEnv {
	HUB: DurableObjectNamespace<Hub>;
	/** Overrides the stale-socket window; only tests set it. */
	HUB_STALE_MS?: string;
}

export function hubStub(env: HubEnv): DurableObjectStub<Hub> {
	return env.HUB.get(env.HUB.idFromName(HUB_NAME));
}

/** A socket must be accepted to carry a close code; a plain 401 would look like a network error. */
export function unauthorizedSocket(): Response {
	const { 0: client, 1: server } = new WebSocketPair();
	server.accept();
	server.close(UNAUTHORIZED_CLOSE_CODE, "Unauthorized");
	return new Response(null, { status: 101, webSocket: client });
}
