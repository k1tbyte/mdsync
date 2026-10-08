import { fingerprint } from "../secret";

const IPV6_GROUPS = 8;
/** One household or office holds a whole /64, so that is one client. */
const IPV6_PREFIX_GROUPS = 4;
const CLIENT_HEX = 16;

/** Who is asking, as an opaque id: the link remembers wrong guesses per client, never an address. */
export async function clientOf(request: Request): Promise<string> {
	const address = request.headers.get("CF-Connecting-IP") ?? "";
	return (await fingerprint(networkOf(address))).slice(0, CLIENT_HEX);
}

export function networkOf(address: string): string {
	if (!address.includes(":")) return address;
	const [head = "", tail] = address.toLowerCase().split("::");
	const front = head === "" ? [] : head.split(":");
	const back = tail === undefined || tail === "" ? [] : tail.split(":");
	const gap = Math.max(IPV6_GROUPS - front.length - back.length, 0);
	return [...front, ...Array(gap).fill("0"), ...back]
		.slice(0, IPV6_PREFIX_GROUPS)
		.map((group) => group.replace(/^0+(?=.)/, ""))
		.join(":");
}
