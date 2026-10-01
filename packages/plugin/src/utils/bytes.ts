/**
 * A view may sit inside a larger buffer, so `.buffer` would expose its surroundings: copies unless the view
 * spans the whole buffer.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes.buffer as ArrayBuffer;
	}
	return bytes.slice().buffer as ArrayBuffer;
}
