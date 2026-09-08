import assert from 'node:assert/strict';
import test from 'node:test';
import { PREFETCH_TARGET_SECONDS, prefetchWindow, shouldPrimeSuccessor } from '../../src/offscreen/prefetch_window.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';

/** 160 words per minute at speed 1, so 16 words is exactly six seconds of speech. */
function unitOfWords(words: number): SpeechUnit {
	return { text: Array.from({ length: words }, () => 'word').join(' '), pauseAfterMs: 0 };
}

const units = Array.from({ length: 60 }, () => unitOfWords(16));

test('buffers ahead until the target duration is reached', () => {
	const window = prefetchWindow(units, 0, 'en', 1, 30);
	assert.deepEqual(window, [1, 2, 3, 4, 5], 'five six-second units reach thirty seconds');
});

test('starts strictly after the unit being played', () => {
	assert.equal(prefetchWindow(units, 10, 'en', 1, 30)[0], 11);
});

test('stops at the end of the article', () => {
	assert.deepEqual(prefetchWindow(units.slice(0, 3), 0, 'en', 1, 300), [1, 2]);
});

test('returns nothing when the last unit is playing', () => {
	assert.deepEqual(prefetchWindow(units.slice(0, 3), 2, 'en', 1, 300), []);
});

// Faster playback drains the buffer faster, so the same wall-clock target needs more units.
test('accounts for playback speed', () => {
	assert.ok(prefetchWindow(units, 0, 'en', 2, 30).length > prefetchWindow(units, 0, 'en', 1, 30).length);
});

test('targets three minutes by default', () => {
	assert.equal(PREFETCH_TARGET_SECONDS, 180);
	assert.equal(prefetchWindow(units, 0, 'en', 1).length, 30, 'thirty six-second units cover three minutes');
});

// Supertonic runs WASM inference on the offscreen document's main thread, so its successor has to
// be ready before the first source starts or the inference delays the onended callback.
test('always primes the successor on the on-device path', () => {
	assert.equal(shouldPrimeSuccessor('supertonic', 30), true);
	assert.equal(shouldPrimeSuccessor('supertonic', 0.5), true);
});

// The cloud path does no main-thread inference, so the first unit only has to outlast the worst
// case for its successor: a dropped request going silent, then a backoff and a retry.
test('skips priming on the cloud path when the first unit covers a successor retry', () => {
	assert.equal(shouldPrimeSuccessor('edge', 10), false);
	assert.equal(shouldPrimeSuccessor('edge', 3.8), false, 'a typical news headline already covers it');
});

test('still primes on the cloud path when the first unit is too short to cover one', () => {
	assert.equal(shouldPrimeSuccessor('edge', 1.5), true);
	assert.equal(shouldPrimeSuccessor('edge', 0), true);
});
