import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCenteredScrollOffset, performCenteredScroll, UserScrollPauseManager } from '../../src/shared/scroll_helper.ts';

test('does not scroll when highlight is within 20%-80% viewport safe zone', () => {
	const viewportHeight = 1000;
	// Highlight at top=400, height=20 -> center is 410 (between 200 and 800)
	const result = calculateCenteredScrollOffset({ top: 400, height: 20 }, viewportHeight);
	assert.equal(result.shouldScroll, false);
	assert.equal(result.deltaY, 0);
});

test('does not scroll when highlight center is exactly at 20% boundary', () => {
	const viewportHeight = 1000;
	// Highlight at top=190, height=20 -> center is 200 (exactly at 20%)
	const result = calculateCenteredScrollOffset({ top: 190, height: 20 }, viewportHeight);
	assert.equal(result.shouldScroll, false);
	assert.equal(result.deltaY, 0);
});

test('does not scroll when highlight center is exactly at 80% boundary', () => {
	const viewportHeight = 1000;
	// Highlight at top=790, height=20 -> center is 800 (exactly at 80%)
	const result = calculateCenteredScrollOffset({ top: 790, height: 20 }, viewportHeight);
	assert.equal(result.shouldScroll, false);
	assert.equal(result.deltaY, 0);
});

test('calculates correct deltaY to center highlight when above 20% safe zone', () => {
	const viewportHeight = 1000;
	// Highlight at top=100, height=20 -> center is 110 (< 200)
	// Target center is 500. Expected deltaY = 110 - 500 = -390
	const result = calculateCenteredScrollOffset({ top: 100, height: 20 }, viewportHeight);
	assert.equal(result.shouldScroll, true);
	assert.equal(result.deltaY, -390);
});

test('calculates correct deltaY to center highlight when below 80% safe zone', () => {
	const viewportHeight = 1000;
	// Highlight at top=850, height=20 -> center is 860 (> 800)
	// Target center is 500. Expected deltaY = 860 - 500 = 360
	const result = calculateCenteredScrollOffset({ top: 850, height: 20 }, viewportHeight);
	assert.equal(result.shouldScroll, true);
	assert.equal(result.deltaY, 360);
});

test('UserScrollPauseManager ignores scroll interaction when playback is NOT active', () => {
	const manager = new UserScrollPauseManager(3000);
	manager.setPlaybackState(false);
	manager.onUserInteraction();
	assert.equal(manager.isPaused(), false);
});

test('UserScrollPauseManager pauses auto-scroll for 3s when playback IS active', () => {
	let currentTime = 10000;
	const manager = new UserScrollPauseManager(3000, () => currentTime);
	manager.setPlaybackState(true);

	assert.equal(manager.isPaused(), false);
	manager.onUserInteraction();
	assert.equal(manager.isPaused(), true);

	// Advance time by 2 seconds -> still paused
	currentTime += 2000;
	assert.equal(manager.isPaused(), true);

	// Advance time by another 1.1 seconds (total 3.1s) -> no longer paused
	currentTime += 1100;
	assert.equal(manager.isPaused(), false);
});

test('UserScrollPauseManager debounces: repeated interaction extends pause window', () => {
	let currentTime = 10000;
	const manager = new UserScrollPauseManager(3000, () => currentTime);
	manager.setPlaybackState(true);

	manager.onUserInteraction();
	assert.equal(manager.isPaused(), true);

	// After 2s, user scrolls again -> pausedUntil extends to currentTime + 3s
	currentTime += 2000;
	manager.onUserInteraction();

	// After another 2s (4s total from first, 2s from second) -> still paused
	currentTime += 2000;
	assert.equal(manager.isPaused(), true);

	// After another 1.1s (3.1s from second interaction) -> no longer paused
	currentTime += 1100;
	assert.equal(manager.isPaused(), false);
});

test('UserScrollPauseManager resets pause state when playback stops', () => {
	let currentTime = 10000;
	const manager = new UserScrollPauseManager(3000, () => currentTime);
	manager.setPlaybackState(true);
	manager.onUserInteraction();
	assert.equal(manager.isPaused(), true);

	// Stop playback -> pause reset immediately
	manager.setPlaybackState(false);
	assert.equal(manager.isPaused(), false);
});

test('performCenteredScroll returns false when paused', () => {
	let currentTime = 10000;
	const manager = new UserScrollPauseManager(3000, () => currentTime);
	manager.setPlaybackState(true);
	manager.onUserInteraction();

	let scrollCalled = false;
	const mockScrollFn = () => {
		scrollCalled = true;
	};

	const result = performCenteredScroll({ top: 50, height: 20 }, 1000, manager, mockScrollFn, false);
	assert.equal(result, false);
	assert.equal(scrollCalled, false);
});

test('performCenteredScroll scrolls with smooth behavior when not paused and out of safe zone', () => {
	let scrolledOffset = 0;
	let scrollBehavior = '';
	const mockScrollFn = (opts: { top: number; behavior: ScrollBehavior }) => {
		scrolledOffset = opts.top;
		scrollBehavior = opts.behavior;
	};

	const manager = new UserScrollPauseManager(3000);
	manager.setPlaybackState(true);

	// center = 50 + 10 = 60 (< 200 in 1000px viewport)
	// deltaY = 60 - 500 = -440
	const result = performCenteredScroll({ top: 50, height: 20 }, 1000, manager, mockScrollFn, false);
	assert.equal(result, true);
	assert.equal(scrolledOffset, -440);
	assert.equal(scrollBehavior, 'smooth');
});

test('performCenteredScroll uses auto behavior when prefersReducedMotion is true', () => {
	let scrollBehavior = '';
	const mockScrollFn = (opts: { top: number; behavior: ScrollBehavior }) => {
		scrollBehavior = opts.behavior;
	};

	const result = performCenteredScroll({ top: 50, height: 20 }, 1000, undefined, mockScrollFn, true);
	assert.equal(result, true);
	assert.equal(scrollBehavior, 'auto');
});

test('performCenteredScroll returns false when within safe zone', () => {
	let scrollCalled = false;
	const mockScrollFn = () => {
		scrollCalled = true;
	};

	const result = performCenteredScroll({ top: 400, height: 20 }, 1000, undefined, mockScrollFn, false);
	assert.equal(result, false);
	assert.equal(scrollCalled, false);
});
