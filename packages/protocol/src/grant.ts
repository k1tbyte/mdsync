const encoder = new TextEncoder();

/** HMAC-SHA256(relay secret, channel) as lowercase hex: opens that channel and no other. */
export async function deriveChannelGrant(
	secret: string,
	channel: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(channel));
	return [...new Uint8Array(mac)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
