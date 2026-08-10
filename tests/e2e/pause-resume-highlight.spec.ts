import type { PlaybackStateResponse } from '../../src/shared/types';
import { expect, test } from './fixtures';

const highlightRegistryName = 'readit-dev-word-highlight';

test.use({ freshExtensionWorker: true });

/**
 * A pause long enough for the keepalive to have fired several times.
 *
 * This does NOT cover the reported freeze. That one came from Chrome evicting the idle
 * service worker during the pause, and Playwright's attachment to the worker keeps it
 * alive, so the eviction never happens here. `readable_surface.test.ts` guards that.
 * What this test does cover is the audio clock staying aligned across a long suspend.
 */
const LONG_PAUSE_MS = 65_000;

async function highlightedWord(page: import('@playwright/test').Page): Promise<string | null> {
	return page.evaluate((name) => {
		const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
		const [range] = highlight ? [...highlight] : [];
		return range?.toString() ?? null;
	}, highlightRegistryName);
}

async function playbackStatus(sender: import('@playwright/test').Page): Promise<string | null> {
	const state = await sender.evaluate(
		() => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }) as Promise<PlaybackStateResponse>,
	);
	return state.session?.status ?? null;
}

test('the word highlight keeps advancing after a minute-long pause', async ({ context, extensionId }) => {
	test.setTimeout(600_000);
	const targetUrl = 'https://readit.test/pause-resume-highlight';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body:
				'<!doctype html><html lang="en"><head><title>Pause and resume</title></head><body><article><h1>Pause and resume</h1>' +
				'<p>This article carries enough continuous readable prose that playback keeps running for a long while before it reaches the final sentence of the document. ' +
				'The reader walks through every word in order and projects the active one back onto the live page so the highlight follows the spoken audio closely. ' +
				'A listener who pauses in the middle of a paragraph expects the highlight to pick up from exactly the same place once playback resumes again. ' +
				'Because the audio clock stops while the context is suspended, the elapsed time used for highlighting must stay aligned with the audio after resuming. ' +
				'That alignment is the behaviour under test here, and it only shows up once the pause has lasted long enough for the keepalive to run several times.</p>' +
				'</article></body></html>',
		}),
	);

	const article = await context.newPage();
	await article.goto(targetUrl, { waitUntil: 'domcontentloaded' });
	const sender = await context.newPage();
	await sender.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await article.bringToFront();

	await expect
		.poll(
			async () => {
				try {
					return await sender.evaluate(() => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE' }));
				} catch (_err) {
					return null;
				}
			},
			{ timeout: 10_000 },
		)
		.toEqual({ success: true });

	await expect.poll(() => playbackStatus(sender), { timeout: 240_000 }).toBe('playing');
	await expect.poll(() => highlightedWord(article), { timeout: 30_000 }).not.toBeNull();

	await sender.evaluate(() => chrome.runtime.sendMessage({ action: 'PAUSE_READING' }));
	await expect.poll(() => playbackStatus(sender), { timeout: 15_000 }).toBe('paused');

	const wordAtPause = await highlightedWord(article);
	await sender.waitForTimeout(LONG_PAUSE_MS);

	// The highlight must not have wandered off while the audio clock was frozen.
	expect(await highlightedWord(article)).toBe(wordAtPause);

	await sender.evaluate(() => chrome.runtime.sendMessage({ action: 'RESUME_READING' }));
	await expect.poll(() => playbackStatus(sender), { timeout: 15_000 }).toBe('playing');

	// "Moved at all" is too weak: a hidden document whose timers got throttled still
	// advances, just once a second, which is exactly what reads as frozen. Sample over
	// several seconds and require the highlight to walk through a run of distinct words.
	const seen = new Set<string>();
	for (let sample = 0; sample < 40; sample++) {
		const word = await highlightedWord(article);
		if (word) {
			seen.add(word);
		}
		await article.waitForTimeout(250);
	}

	expect(seen.has(wordAtPause ?? '')).toBe(true);
	expect(seen.size).toBeGreaterThan(4);
});
