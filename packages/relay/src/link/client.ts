import { fingerprint } from "../secret";

const IPV6_GROUPS = 8;
/** One household or office holds a whole /64, so that is one client. */
const IPV6_PREFIX_GROUPS = 4;
const CLIENT_HEX = 16;

/** Who is asking, as an opaque id: the link remembers wrong guesses per client, never an address. */
export async function clientOf(request: Request): Promise<string> {
	// Fail closed in one shared bucket if missing; Cloudflare always sets this header.
	const address = request.headers.get("CF-Connecting-IP") ?? "";
	return (await fingerprint(networkOf(address))).slice(0, CLIENT_HEX);
}

export function networkOf(address: string): string {
	if (!address.includes(":")) return address;
	const [head = "", tail] = address
		.toLowerCase()
		.replace(
			/(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
			(_tail, a, b, c, d) =>
				`${(Number(a) * 256 + Number(b)).toString(16)}:${(Number(c) * 256 + Number(d)).toString(16)}`,
		)
		.split("::");
	const front = head === "" ? [] : head.split(":");
	const back = tail === undefined || tail === "" ? [] : tail.split(":");
	const gap = Math.max(IPV6_GROUPS - front.length - back.length, 0);
	const groups = [...front, ...Array(gap).fill("0"), ...back].map((group) =>
		group.replace(/^0+(?=.)/, ""),
	);
	if (
		["0:0:0:0:0:ffff", "64:ff9b:0:0:0:0"].includes(groups.slice(0, 6).join(":"))
	) {
		return groups
			.slice(6)
			.flatMap((group) => {
				const value = Number.parseInt(group, 16);
				return [value >> 8, value & 255];
			})
			.join(".");
	}
	return groups.slice(0, IPV6_PREFIX_GROUPS).join(":");
}
