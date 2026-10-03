import { beforeEach, describe, expect, it, vi } from "vitest";
import { createShareRegistration } from "@/plugin/share-registration";
import { DEFAULT_SETTINGS, type MdsyncSettings } from "@/settings/model";
import type { SpaceRecord } from "@/spaces/record";
import { SpaceRecords } from "@/spaces/records";

const broker = vi.hoisted(() => ({
	listParticipants: vi.fn(async (_admin: unknown, id: string) =>
		id === "mine" ? [{ id: "p1", label: "Friend", readOnly: false }] : [],
	),
	registerShareStorage: vi.fn(
		async (
			_admin: unknown,
			_id: string,
			_s3: { secretAccessKey: string },
		) => {},
	),
}));
vi.mock("@/storage", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	...broker,
}));

const LOCATION = {
	endpoint: "https://s3.example",
	region: "auto",
	bucket: "notes",
	prefix: "vault",
	forcePathStyle: true,
};

function share(id: string, kind: "owner" | "participant"): SpaceRecord {
	return {
		id,
		name: id,
		root: id,
		rev: 1,
		author: "laptop",
		key: "",
		access:
			kind === "owner"
				? { kind, location: LOCATION }
				: {
						kind,
						relayUrl: "https://other.example",
						token: "t",
						participantId: "p1",
						personName: "Friend",
					},
	};
}

function host(spaces: SpaceRecord[]) {
	const settings = {
		...DEFAULT_SETTINGS,
		relayUrl: "https://relay.example",
		relaySecret: "secret",
		activeStorageKind: "s3",
		storageConfigs: {
			s3: {
				...LOCATION,
				kind: "s3",
				accessKeyId: "id",
				secretAccessKey: "old",
				concurrency: 4,
			},
		},
		spaces,
	} as MdsyncSettings;
	const logs = { warn: vi.fn(async () => {}) };
	return { settings, spaces: new SpaceRecords(settings, async () => {}), logs };
}

function rotate(device: ReturnType<typeof host>, secret: string): void {
	Object.assign(device.settings.storageConfigs.s3 ?? {}, {
		secretAccessKey: secret,
	});
}

const sent = () =>
	broker.registerShareStorage.mock.calls.map(
		([, id, s3]) => `${id}:${s3.secretAccessKey}`,
	);

beforeEach(() => {
	broker.registerShareStorage.mockReset();
});

describe("the owner's storage on the relay", () => {
	it("goes where people were invited, again once per change of credentials", async () => {
		const device = host([
			share("mine", "owner"),
			share("alone", "owner"),
			share("theirs", "participant"),
		]);
		const refreshed = createShareRegistration(device);

		await refreshed({ id: "mine", root: "mine" });
		await refreshed({ id: "alone", root: "alone" });
		await refreshed({ id: "theirs", root: "theirs" });
		await refreshed({ id: "mine", root: "mine" });
		rotate(device, "new");
		await refreshed({ id: "mine", root: "mine" });

		expect(sent()).toEqual(["mine:old", "mine:new"]);
	});

	it("sends the same credentials again an hour later, over whatever another device sent", async () => {
		vi.useFakeTimers();
		const device = host([share("mine", "owner")]);
		const refreshed = createShareRegistration(device);

		await refreshed({ id: "mine", root: "mine" });
		await refreshed({ id: "mine", root: "mine" });
		vi.advanceTimersByTime(60 * 60_000);
		await refreshed({ id: "mine", root: "mine" });
		vi.useRealTimers();

		expect(sent()).toEqual(["mine:old", "mine:old"]);
	});

	it("sends one at a time, so the newest credentials land last", async () => {
		const device = host([share("mine", "owner")]);
		const refreshed = createShareRegistration(device);
		let release = () => {};
		broker.registerShareStorage.mockImplementationOnce(
			() => new Promise<void>((resolve) => (release = resolve)),
		);

		const first = refreshed({ id: "mine", root: "mine" });
		await vi.waitFor(() => expect(sent()).toEqual(["mine:old"]));
		rotate(device, "new");
		const second = refreshed({ id: "mine", root: "mine" });
		expect(sent()).toEqual(["mine:old"]);
		release();
		await Promise.all([first, second]);

		expect(sent()).toEqual(["mine:old", "mine:new"]);
	});

	it("waits for a relay, and tries again after a failed send", async () => {
		const device = host([share("mine", "owner")]);
		const refreshed = createShareRegistration(device);
		device.settings.relaySecret = "";
		await refreshed({ id: "mine", root: "mine" });
		expect(sent()).toEqual([]);

		device.settings.relaySecret = "secret";
		broker.registerShareStorage.mockRejectedValueOnce(new Error("offline"));
		await refreshed({ id: "mine", root: "mine" });
		await refreshed({ id: "mine", root: "mine" });

		expect(device.logs.warn).toHaveBeenCalledOnce();
		expect(sent()).toEqual(["mine:old", "mine:old"]);
	});
});
