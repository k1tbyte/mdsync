import { decodeServer, EFrame } from "@mdsync/protocol";
import { describe, expect, it } from "vitest";

import { broadcast, signalFrame } from "../../src/hub/frames";
import { grant, peer } from "../helpers/hub";

const VAULT = "vault-channel";

function listening(tag: number, slot: number) {
	const slots = Array.from({ length: slot + 1 }, () => null);
	const fake = peer(
		tag,
		slots.map((_, at) => (at === slot ? grant(VAULT) : null)),
	);
	const sent: Uint8Array[] = [];
	fake.send = (bytes) => void sent.push(bytes);
	return { fake, sent };
}

describe("broadcast", () => {
	it("encodes once per distinct slot and readdresses each recipient", () => {
		const [a, b, c] = [listening(1, 0), listening(2, 3), listening(3, 3)];

		broadcast(
			[a.fake, b.fake, c.fake],
			VAULT,
			"d".repeat(32),
			signalFrame(7),
			() => true,
		);

		expect(b.sent[0]).toBe(c.sent[0]);
		expect(a.sent[0]).not.toBe(b.sent[0]);
		expect(decodeServer(a.sent[0] as Uint8Array)).toMatchObject({
			type: EFrame.Signal,
			slot: 0,
		});
		expect(decodeServer(b.sent[0] as Uint8Array)).toMatchObject({
			type: EFrame.Signal,
			slot: 3,
		});
	});
});
