import assert from 'node:assert/strict';
import test from 'node:test';
import { base64ToBytes, bytesToBase64 } from '../../src/shared/base64.ts';

test('round-trips arbitrary bytes', () => {
	const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x7f, 0x80]);
	assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

test('encodes a ZIP signature to the expected prefix', () => {
	assert.equal(bytesToBase64(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), 'UEsDBA==');
});

test('encodes a buffer far larger than the call-stack argument limit', () => {
	const bytes = new Uint8Array(300_000);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = index % 256;
	}
	const encoded = bytesToBase64(bytes);
	assert.deepEqual(base64ToBytes(encoded), bytes);
});
