import { expect } from "vitest";
import { SyncController } from "@/sync/controller";
import { pullPaths } from "@/sync/pull";
import { createTestControllerHost } from "./controller";
import { killNextWrite } from "./faults";
import { pairedSessions, type TestSession } from "./session";

export const BEFORE = Array.from(
	{ length: 10 },
	(_, i) => `line ${i + 1}`,
).join("\n");
export const AFTER = BEFORE.replace("line 1", "LINE 1 edited");

export const isNote = (path: string) => path === "note.md";

export function device(session: TestSession): () => Promise<void> {
	const controller = new SyncController(createTestControllerHost(session));
	return async () => {
		await controller.refreshAndAutoSync();
		await controller.refresh();
	};
}

/** The phone holds BEFORE as its baseline; the laptop published AFTER. */
export async function behind(path = "note.md"): Promise<TestSession> {
	const [laptop, phone] = pairedSessions();
	const syncLaptop = device(laptop);
	laptop.adapter.putText(path, BEFORE);
	await syncLaptop();
	await phone.adoptRemote();
	phone.adapter.putText(path, BEFORE);
	laptop.adapter.putText(path, AFTER);
	await syncLaptop();
	return phone;
}

/** Its pull of AFTER dies part way. */
export async function cutShort(
	leaves: "prefix" | "nothing",
	path = "note.md",
): Promise<TestSession> {
	const phone = await behind(path);
	killNextWrite(phone.adapter, (each) => each === path, leaves);
	const pulled = await pullPaths(phone.deps(), await phone.compare(), [path]);
	expect(pulled.failed).toMatchObject({ message: "killed mid-write" });
	return phone;
}
