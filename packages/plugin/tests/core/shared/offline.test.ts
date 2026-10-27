import { afterEach, describe, expect, it, vi } from "vitest";

import {
	isNetworkError,
	isOffline,
	OFFLINE_MESSAGE,
	userMessage,
} from "@/core/shared/offline";
import {
	StorageHttpError,
	StorageTimeoutError,
} from "@/core/shared/transport-errors";

function browserOnline(online: boolean): void {
	vi.stubGlobal("navigator", { onLine: online });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("isNetworkError", () => {
	it.each([
		"net::ERR_INTERNET_DISCONNECTED",
		"Failed to fetch",
		"Load failed",
		"The Internet connection appears to be offline.",
		'Unable to resolve host "s3.example.com"',
		"java.net.UnknownHostException",
		"getaddrinfo ENOTFOUND s3.example.com",
		"The network connection was lost.",
		"NetworkError when attempting to fetch resource.",
		"Network request failed",
	])("reads %j as a lost connection", (message) => {
		expect(isNetworkError(new Error(message))).toBe(true);
	});

	it("counts a timeout, however it is wrapped", () => {
		expect(isNetworkError(new StorageTimeoutError(30_000))).toBe(true);
		const wrapped = new Error("S3 GET to listing failed: timed out");
		wrapped.name = "TimeoutError";
		expect(isNetworkError(wrapped)).toBe(true);
	});

	it("leaves answers from the storage alone", () => {
		expect(isNetworkError(new StorageHttpError(500, "network hiccup"))).toBe(
			false,
		);
		expect(isNetworkError(new Error("Remote vault id does not match"))).toBe(
			false,
		);
		expect(isNetworkError("network")).toBe(false);
		expect(
			isNetworkError(new Error("Missing remote object for offline.md")),
		).toBe(false);
		expect(isNetworkError(new Error("Could not read network.md"))).toBe(false);
		expect(
			isNetworkError(new Error("Missing remote object for Network Errors.md")),
		).toBe(false);
		expect(
			isNetworkError(new Error('"Network Requests" lost every file it had')),
		).toBe(false);
		expect(isNetworkError(undefined)).toBe(false);
	});
});

describe("isOffline", () => {
	it("is true for any failure while the browser is offline", () => {
		browserOnline(false);
		expect(isOffline()).toBe(true);
		expect(isOffline(new Error("something unrecognised"))).toBe(true);
	});

	it("needs a network failure while the browser is online", () => {
		browserOnline(true);
		expect(isOffline()).toBe(false);
		expect(isOffline(new Error("Failed to fetch"))).toBe(true);
		expect(isOffline(new Error("Access denied"))).toBe(false);
	});
});

describe("userMessage", () => {
	it("swaps the offline failures for one line", () => {
		browserOnline(true);
		expect(userMessage(new Error("net::ERR_NETWORK_CHANGED"))).toBe(
			OFFLINE_MESSAGE,
		);
		expect(userMessage(new Error("Access denied"))).toBe("Access denied");
	});
});
