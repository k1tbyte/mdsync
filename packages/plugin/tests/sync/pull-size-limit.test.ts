import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";

import { pullPathsOp } from "@/sync/operations/pull";
import { pushPathsOp } from "@/sync/operations/push";

useEncryptionKey();

describe("pulling past this device's size limit", () => {
	it("leaves a file over the limit remote and pulls the rest", async () => {
		const [a, b] = pairedSessions();
		b.adapter.putText("big.md", "0123456789");
		b.adapter.putText("small.md", "s");
		const theirs = await b.compare();
		await pushPathsOp(b.deps(), theirs, ["big.md", "small.md"], b.context());

		const incoming = await a.compare();
		const outcome = await pullPathsOp(
			{ ...a.deps(), maxFileBytes: 5 },
			incoming,
			["big.md", "small.md"],
			a.context(),
		);

		expect([...outcome.touchedPaths]).toEqual(["small.md"]);
		expect(await a.adapter.exists("big.md")).toBe(false);
	});
});
