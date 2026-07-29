import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectMp3 } from '../e2e/mp3.ts';

function frame(bitrateIndex = 7, marker?: 'Info' | 'Xing'): Uint8Array {
	const length = Math.floor((144_000 * [0, 32, 40, 48, 56, 64, 80, 96, 112][bitrateIndex]) / 44_100);
	const bytes = new Uint8Array(length);
	bytes.set([0xff, 0xfb, bitrateIndex << 4, 0xc0]);
	if (marker) {
		bytes.set(
			[...marker].map((character) => character.charCodeAt(0)),
			21,
		);
	}
	return bytes;
}

test('inspects a minimal consistent 96 kbps mono MPEG Layer III sequence', () => {
	const bytes = new Uint8Array([...frame(), ...frame()]);
	assert.deepEqual(inspectMp3(bytes), {
		frameCount: 2,
		bitrateKbps: 96,
		channelCount: 1,
		durationSeconds: (2 * 1_152) / 44_100,
	});
});

test('ignores a Xing or Info metadata frame when measuring encoded audio', () => {
	const bytes = new Uint8Array([...frame(6, 'Info'), ...frame()]);
	assert.deepEqual(inspectMp3(bytes), {
		frameCount: 1,
		bitrateKbps: 96,
		channelCount: 1,
		durationSeconds: 1_152 / 44_100,
	});
});

test('rejects invalid sync, truncated frames, and inconsistent headers', () => {
	assert.throws(() => inspectMp3([0, 1, 2, 3]), /sync/);
	assert.throws(() => inspectMp3([0xff, 0xfb, 0x70, 0xc0]), /Truncated/);
	assert.throws(() => inspectMp3(new Uint8Array([...frame(), ...frame(8)])), /Inconsistent/);
});
