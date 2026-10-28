import { DEFAULT_CONCURRENCY } from "@/core/constants";
import { decryptJson, type EncryptionKey, encryptJson } from "@/core/crypto";
import { reportWarning } from "@/core/shared";
import { runWithConcurrency } from "@/core/utils";
import type { ListedObject, ObjectStorage } from "@/features/storage";
import { REMOTE_PINS_PREFIX } from "../constants";
import { manifestToSpace, manifestToVault } from "../remote/space-paths";
import type { Manifest } from "../types";

/** A pin is its own full manifest, so it outlives the records it was replayed from. */
export interface Pin {
	id: string;
	manifest: Manifest;
	label?: string;
	pinnedAt: number;
}

interface StoredPin {
	v: 1;
	manifest: Manifest;
	label?: string;
	pinnedAt: number;
}

/** A pin without its manifest: what a row shows. */
export interface PinInfo {
	id: string;
	label?: string;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
}

export interface PinsRead<T> {
	/** Newest snapshot first, each as `pick` reduced it. */
	pins: { info: PinInfo; picked: T }[];
	/** Listed pins that could not be read: what they hold is unknown. */
	unreadable: string[];
}

/** Manifests are big, so only a few stay. */
const PIN_CACHE_SIZE = 4;

// A relabel rewrites the object, and only its etag proves it unchanged: a timestamp may not move within its resolution.
// Infos are a few strings each, so every listed pin keeps one and a warm Timeline refresh downloads no manifest.
const pinCache = new WeakMap<
	ObjectStorage,
	{
		key: EncryptionKey;
		root: string;
		pins: Map<string, { etag: string; pin: Pin }>;
		infos: Map<string, { etag: string; info: PinInfo }>;
	}
>();

export function pinKey(snapshotId: string): string {
	return `${REMOTE_PINS_PREFIX}${snapshotId}.json.enc`;
}

export async function writePin(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	pin: Pin,
): Promise<void> {
	const stored: StoredPin = {
		v: 1,
		manifest: manifestToSpace(pin.manifest, root),
		label: pin.label,
		pinnedAt: pin.pinnedAt,
	};
	await storage.put(
		pinKey(pin.id),
		await encryptJson(key, stored),
		"application/octet-stream",
	);
}

export function deletePin(
	storage: ObjectStorage,
	snapshotId: string,
): Promise<void> {
	return storage.delete(pinKey(snapshotId));
}

/** Every listed pin, reduced by `pick` as it is read so no more than the cache's manifests are held at once. */
export function readPins<T>(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	pick: (pin: Pin) => T,
): Promise<PinsRead<T>> {
	return scanPins(storage, key, root, pick);
}

/** Every listed pin's info, newest first; a pin whose etag is unchanged costs no GET. */
export async function readPinInfos(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
): Promise<{ pins: PinInfo[]; unreadable: string[] }> {
	const read = await scanPins(
		storage,
		key,
		root,
		() => null,
		() => null,
	);
	return {
		pins: read.pins.map(({ info }) => info),
		unreadable: read.unreadable,
	};
}

/** `fromInfo` answers a pin whose cached info is current, so it is not read at all. */
async function scanPins<T>(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	pick: (pin: Pin) => T,
	fromInfo?: (info: PinInfo) => T,
): Promise<PinsRead<T>> {
	let cache = pinCache.get(storage);
	if (cache?.key !== key || cache.root !== root) {
		cache = { key, root, pins: new Map(), infos: new Map() };
		pinCache.set(storage, cache);
	}
	const { pins, infos } = cache;
	const listed = await listPins(storage);
	const listedKeys = new Set(listed.map((object) => object.key));
	for (const storageKey of infos.keys()) {
		if (!listedKeys.has(storageKey)) infos.delete(storageKey);
	}
	const read: PinsRead<T>["pins"] = [];
	const unreadable: string[] = [];
	await runWithConcurrency(listed, DEFAULT_CONCURRENCY, async (object) => {
		const { etag } = object;
		const known = infos.get(object.key);
		if (fromInfo && etag !== null && known?.etag === etag) {
			read.push({ info: known.info, picked: fromInfo(known.info) });
			return;
		}
		const hit = pins.get(object.key);
		let pin = etag !== null && hit?.etag === etag ? hit.pin : null;
		if (!pin) {
			pin = await readPin(storage, key, root, object.key);
			if (!pin) {
				unreadable.push(object.key);
				return;
			}
			if (etag !== null) remember(pins, object.key, { etag, pin });
		}
		const { id, label, manifest } = pin;
		const { createdAt, deviceId, deviceName } = manifest;
		const info = { id, label, createdAt, deviceId, deviceName };
		if (etag !== null) infos.set(object.key, { etag, info });
		read.push({ info, picked: pick(pin) });
	});
	read.sort((a, b) => b.info.createdAt - a.info.createdAt);
	return { pins: read, unreadable };
}

/** One pin, null when absent or unreadable. */
export async function readPinById(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	snapshotId: string,
): Promise<Pin | null> {
	return readPin(storage, key, root, pinKey(snapshotId));
}

async function listPins(storage: ObjectStorage): Promise<ListedObject[]> {
	if (storage.listDetailed) return storage.listDetailed(REMOTE_PINS_PREFIX);
	return (await storage.list(REMOTE_PINS_PREFIX)).map((key) => ({
		key,
		etag: null,
		modified: null,
	}));
}

async function readPin(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	storageKey: string,
): Promise<Pin | null> {
	const blob = await storage.get(storageKey);
	if (!blob) return null;
	const id = storageKey.slice(REMOTE_PINS_PREFIX.length, -".json.enc".length);
	try {
		const stored = await decryptJson<StoredPin>(key, blob);
		if (stored.v !== 1 || stored.manifest?.snapshotId !== id) return null;
		return {
			id,
			manifest: manifestToVault(stored.manifest, root),
			label: stored.label,
			pinnedAt: stored.pinnedAt,
		};
	} catch (err) {
		reportWarning(`Pinned snapshot "${id}" is unreadable.`, err);
		return null;
	}
}

function remember(
	pins: Map<string, { etag: string; pin: Pin }>,
	storageKey: string,
	entry: { etag: string; pin: Pin },
): void {
	pins.delete(storageKey);
	pins.set(storageKey, entry);
	for (const oldest of pins.keys()) {
		if (pins.size <= PIN_CACHE_SIZE) break;
		pins.delete(oldest);
	}
}
