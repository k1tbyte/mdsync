/** A key for one purpose, derived from the raw data key where its bytes exist: the content key is non-extractable. */
export async function deriveFromDataKey(
	dataKey: Uint8Array,
	info: string,
	algorithm: AesKeyGenParams | HmacImportParams,
	usages: KeyUsage[],
): Promise<CryptoKey> {
	const subtle = window.crypto.subtle;
	const material = await subtle.importKey(
		"raw",
		dataKey as BufferSource,
		"HKDF",
		false,
		["deriveKey"],
	);
	return subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			// The data key is uniformly random, so HKDF needs no salt to extract.
			salt: new Uint8Array(),
			info: new TextEncoder().encode(info),
		},
		material,
		algorithm,
		false,
		usages,
	);
}
