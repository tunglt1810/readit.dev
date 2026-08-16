/**
 * Spreading a whole document into `String.fromCharCode` overflows the call stack once the buffer
 * reaches a few hundred kilobytes, and the failure only shows up with real files rather than with
 * small test fixtures. Walking the buffer in chunks keeps the encoder synchronous, which is what
 * lets it run under `node --test` where `FileReader` is not a global.
 */
const CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
