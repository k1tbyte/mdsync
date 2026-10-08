import type { Link } from "./durable-object";

export interface LinkEnv {
	LINK: DurableObjectNamespace<Link>;
}

/** One object per link: a view is counted in the link's own turn, and links never queue behind each other. */
export function linkStub(env: LinkEnv, id: string): DurableObjectStub<Link> {
	return env.LINK.get(env.LINK.idFromName(id));
}
