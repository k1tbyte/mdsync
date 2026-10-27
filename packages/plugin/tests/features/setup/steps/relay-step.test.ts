// @vitest-environment jsdom
import { installElementMethods } from "@tests/helpers/element-methods";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/app/host";
import { mergeSettings } from "@/core/settings/model";
import {
	activateRelay,
	deployOwnRelay,
	failedRelay,
	planRelay,
	runningRelayDeploy,
	useRelay,
} from "@/features/relay/deploy/deploy-flow";
import { createRelayStep } from "@/features/setup/steps/relay-step";
import type { StepView, Wizard } from "@/features/setup/wizard";
import { testRelay } from "@/features/storage/ui/connection-test";

installElementMethods();

const buttons: Array<{ label: string; click: () => void }> = [];

vi.mock("obsidian", async (original) => {
	class Setting {
		readonly settingEl: HTMLElement;
		constructor(parent: HTMLElement) {
			this.settingEl = parent.createDiv();
		}
		setName() {
			return this;
		}
		setDesc() {
			return this;
		}
		addText(build: (text: unknown) => void) {
			const inputEl = this.settingEl.createEl("input");
			const text = {
				inputEl,
				setPlaceholder: () => text,
				setValue: (v: string) => {
					inputEl.value = v;
					return text;
				},
				onChange: (cb: (v: string) => void) => {
					inputEl.addEventListener("input", () => cb(inputEl.value));
					return text;
				},
			};
			build(text);
			return this;
		}
		addButton(build: (button: unknown) => void) {
			const entry = { label: "", click: () => {} };
			const button = {
				buttonEl: this.settingEl.createEl("button"),
				setButtonText: (label: string) => {
					entry.label = label;
					return button;
				},
				setCta: () => button,
				setDisabled: () => button,
				onClick: (cb: () => void) => {
					entry.click = cb;
					return button;
				},
			};
			build(button);
			buttons.push(entry);
			return this;
		}
	}
	return {
		...(await original<typeof import("obsidian")>()),
		Setting,
	};
});
vi.mock("@/features/storage/ui/connection-test", () => ({
	testRelay: vi.fn(),
}));
vi.mock("@/features/storage/cloudflare/cloudflare-login", () => ({
	cloudflareOf: () => ({ api: {}, accountId: "acc" }),
	cloudflareErrorMessage: (err: Error) => err.message,
	forgetCloudflare: vi.fn(),
}));
vi.mock("@/features/relay/deploy/relay-account", async (original) => ({
	...(await original<typeof import("@/features/relay/deploy/relay-account")>()),
	accountRelays: vi.fn(async () => ({ taken: [], subdomain: "me" })),
}));
vi.mock("@/features/relay/deploy/deploy-flow", async (original) => ({
	...(await original<typeof import("@/features/relay/deploy/deploy-flow")>()),
	planRelay: vi.fn(async () => ({ deploy: { name: "r", secret: "s" } })),
	deployOwnRelay: vi.fn(),
	failedRelay: vi.fn(() => null),
	runningRelayDeploy: vi.fn(() => null),
	activateRelay: vi.fn(),
	useRelay: vi.fn(async () => {}),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function setup() {
	const plugin = {
		settings: mergeSettings(null),
		saveSettings: vi.fn(async () => {}),
		unloaded: false,
	} as unknown as PluginHost & { unloaded: boolean };
	const el = document.createElement("div");
	document.body.replaceChildren(el);
	let open = true;
	let view: StepView | null = null;
	const wizard = {
		plugin,
		isShowing: (v: StepView) => open && v === view,
		isLive: () => open,
		redraw: () => {
			el.replaceChildren();
			buttons.length = 0;
			if (open) view?.render(el);
		},
		next: vi.fn(),
		choose: vi.fn(),
		close: () => {
			open = false;
		},
	} satisfies Wizard;
	view = createRelayStep(wizard);
	wizard.redraw();
	const card = (title: string) =>
		[...el.querySelectorAll<HTMLButtonElement>(".mdsync-choice")]
			.find((c) => c.textContent?.includes(title))
			?.click();
	const press = (label: string) =>
		buttons.find((b) => b.label === label)?.click();
	return { plugin, wizard, view, el, card, press };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function enter(input: HTMLInputElement): void {
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(runningRelayDeploy).mockReturnValue(null);
	vi.mocked(failedRelay).mockReturnValue(null);
});

describe("the manual relay form", () => {
	function fill(el: HTMLElement): HTMLInputElement[] {
		const inputs = [...el.querySelectorAll("input")];
		const [url, secret] = inputs;
		if (!url || !secret) throw new Error("no form");
		url.value = "https://relay.example";
		url.dispatchEvent(new Event("input"));
		secret.value = "typed";
		secret.dispatchEvent(new Event("input"));
		return inputs;
	}

	it.each([0, 1])("connects on Enter in input %i", async (at) => {
		vi.mocked(testRelay).mockResolvedValue({ ok: true, message: "" });
		const { plugin, el, card, wizard } = setup();
		card("I already have a relay");
		const input = fill(el)[at];
		if (!input) throw new Error("no input");

		enter(input);
		await flush();

		expect(plugin.settings).toMatchObject({
			relayUrl: "https://relay.example",
			relaySecret: "typed",
		});
		expect(useRelay).toHaveBeenCalledOnce();
		expect(wizard.next).toHaveBeenCalledOnce();
	});

	it("leaves the settings alone when the wizard closed while the relay was tested", async () => {
		const answer = deferred<{ ok: boolean; message: string }>();
		vi.mocked(testRelay).mockReturnValue(answer.promise);
		const { plugin, el, card, wizard } = setup();
		card("I already have a relay");
		const [url] = fill(el);
		if (!url) throw new Error("no input");

		enter(url);
		await flush();
		wizard.close();
		answer.resolve({ ok: true, message: "" });
		await flush();

		expect(plugin.settings).toMatchObject({ relayUrl: "", relaySecret: "" });
		expect(useRelay).not.toHaveBeenCalled();
	});
});

describe("deploying from the wizard", () => {
	it("blocks Next while deploying and waiting, and frees it once the deploy failed", async () => {
		const upload = deferred<void>();
		vi.mocked(deployOwnRelay).mockReturnValue(upload.promise);
		const { view, card } = setup();
		expect(view.blocksNext?.()).toBe(false);

		card("Deploy to my Cloudflare");
		await flush();
		expect(view.blocksNext?.()).toBe(true);

		upload.reject(new Error("lost"));
		await flush();
		expect(view.blocksNext?.()).toBe(false);
	});

	it("frees Next when the relay stays silent", async () => {
		vi.mocked(deployOwnRelay).mockResolvedValue();
		const silent = deferred<boolean>();
		vi.mocked(activateRelay).mockReturnValue(silent.promise);
		const { view, card } = setup();

		card("Deploy to my Cloudflare");
		await flush();
		expect(view.blocksNext?.()).toBe(true);

		silent.resolve(false);
		await flush();
		expect(view.blocksNext?.()).toBe(false);
	});

	it("retries the deploy that broke off in an earlier wizard", async () => {
		const lost = { name: "mdsync-relay", secret: "kept" };
		vi.mocked(failedRelay).mockReturnValue(lost);
		vi.mocked(deployOwnRelay).mockReturnValue(new Promise(() => {}));
		const { card } = setup();

		card("Deploy to my Cloudflare");
		await flush();

		expect(failedRelay).toHaveBeenCalledWith("acc");
		expect(vi.mocked(planRelay).mock.calls[0]?.[2]).toEqual(lost);
	});

	it("hands the wait to activateRelay and stays put once the wizard closed", async () => {
		vi.mocked(deployOwnRelay).mockResolvedValue();
		const answer = deferred<boolean>();
		vi.mocked(activateRelay).mockReturnValue(answer.promise);
		const { plugin, wizard, card } = setup();

		card("Deploy to my Cloudflare");
		await flush();
		wizard.close();
		answer.resolve(true);
		await flush();

		expect(activateRelay).toHaveBeenCalledExactlyOnceWith(plugin);
		expect(wizard.next).not.toHaveBeenCalled();
	});

	it("ignores a remembered failed deploy once a relay is set", async () => {
		vi.mocked(failedRelay).mockReturnValue({ name: "stale", secret: "old" });
		vi.mocked(deployOwnRelay).mockReturnValue(new Promise(() => {}));
		const { plugin, card } = setup();
		Object.assign(plugin.settings, {
			relayUrl: "https://mine.example",
			relaySecret: "mine",
		});

		card("Deploy to my Cloudflare");
		await flush();

		expect(vi.mocked(planRelay).mock.calls[0]?.[2]).toBeNull();
	});

	it("follows a deploy still running from a closed wizard instead of failing", async () => {
		const running = deferred<void>();
		vi.mocked(runningRelayDeploy).mockReturnValue(running.promise);
		vi.mocked(activateRelay).mockReturnValue(new Promise(() => {}));
		const { el, view, card } = setup();

		card("Deploy to my Cloudflare");
		await flush();
		expect(el.querySelector(".mod-warning")).toBeNull();
		expect(el.textContent).toContain("still deploying");
		expect(view.blocksNext?.()).toBe(true);
		expect(deployOwnRelay).not.toHaveBeenCalled();

		vi.mocked(runningRelayDeploy).mockReturnValue(null);
		running.resolve();
		await flush();
		expect(activateRelay).toHaveBeenCalledOnce();
		expect(deployOwnRelay).not.toHaveBeenCalled();
	});
});
