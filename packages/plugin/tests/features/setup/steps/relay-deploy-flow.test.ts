import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeSettings } from "@/app/settings";
import {
	deployOwnRelay,
	failedRelay,
	planRelay,
	runningRelayDeploy,
} from "@/features/relay/deploy/deploy-flow";
import { accountRelays } from "@/features/relay/deploy/relay-account";
import { relayDeployFlow } from "@/features/setup/steps/relay-deploy-flow";
import type { Wizard } from "@/features/setup/wizard";
import { cloudflareOf } from "@/features/storage/cloudflare/cloudflare-login";

vi.mock("@/features/storage/cloudflare/cloudflare-login", () => ({
	cloudflareOf: vi.fn(),
	cloudflareErrorMessage: (err: Error) => err.message,
	forgetCloudflare: vi.fn(),
}));
vi.mock("@/features/relay/deploy/relay-account", async (original) => ({
	...(await original<typeof import("@/features/relay/deploy/relay-account")>()),
	accountRelays: vi.fn(),
}));
vi.mock("@/features/relay/deploy/deploy-flow", async (original) => ({
	...(await original<typeof import("@/features/relay/deploy/deploy-flow")>()),
	planRelay: vi.fn(),
	deployOwnRelay: vi.fn(),
	failedRelay: vi.fn(),
	runningRelayDeploy: vi.fn(),
	activateRelay: vi.fn(),
}));

function setup() {
	const wizard = {
		plugin: { settings: mergeSettings(null) },
		redraw: vi.fn(),
		isLive: () => true,
		syncMode: null,
	} as unknown as Wizard;
	const online = vi.fn();
	return { wizard, online, flow: relayDeployFlow(wizard, online) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(runningRelayDeploy).mockReturnValue(null);
	vi.mocked(failedRelay).mockReturnValue(null);
});

describe("relayDeployFlow", () => {
	it("asks for a token when there is no Cloudflare login", async () => {
		vi.mocked(cloudflareOf).mockReturnValue(null);
		const { wizard, flow } = setup();

		flow.start();
		await flush();

		expect(flow.state.phase).toBe("token");
		expect(wizard.redraw).toHaveBeenCalled();
		expect(accountRelays).not.toHaveBeenCalled();
	});

	it("shows the name error and deploys nothing for an invalid new name", async () => {
		vi.mocked(cloudflareOf).mockReturnValue({
			api: {},
			accountId: "acc",
		} as NonNullable<ReturnType<typeof cloudflareOf>>);
		vi.mocked(accountRelays).mockResolvedValue({
			taken: ["mdsync-relay"],
			subdomain: "me",
		});
		vi.mocked(planRelay).mockResolvedValue({ ask: null });
		const { flow } = setup();
		flow.start();
		await flush();
		expect(flow.state.phase).toBe("taken");

		flow.setNewName(" Not A Name ");
		flow.deployNew();
		await flush();

		expect(flow.state.newName).toBe("Not A Name");
		expect(flow.state.error).not.toBe("");
		expect(flow.state.phase).toBe("taken");
		expect(deployOwnRelay).not.toHaveBeenCalled();
	});
});
