import { expect, test } from './fixtures';

type MediaSessionProbe = {
	present: boolean;
	playbackState: string | null;
	hasMetadata: boolean;
	title: string | null;
	artist: string | null;
	album: string | null;
	registered: string[];
	positionStateError: string | null;
	lastPosition: { duration: number; position: number; playbackRate: number } | null;
};

/**
 * Reads navigator.mediaSession straight out of the offscreen document. Whether the OS
 * shows a Now Playing tile is not observable from here, but whether we handed Chrome a
 * session to show is.
 */
async function readOffscreenMediaSession(
	context: import('@playwright/test').BrowserContext,
	page: import('@playwright/test').Page,
): Promise<MediaSessionProbe> {
	const cdp = await context.newCDPSession(page);
	const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
	const target = targetInfos.find((targetInfo) => targetInfo.url.includes('/src/offscreen/offscreen.html'));
	if (!target) {
		throw new Error('The offscreen playback document was unavailable.');
	}
	const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
	const messageId = 1;
	const result = new Promise<MediaSessionProbe>((resolve, reject) => {
		const listener = (event: { sessionId: string; message: string }) => {
			if (event.sessionId !== sessionId) {
				return;
			}
			const message = JSON.parse(event.message) as { id?: number; result?: { result?: { value?: MediaSessionProbe } } };
			if (message.id !== messageId) {
				return;
			}
			cdp.off('Target.receivedMessageFromTarget', listener);
			const value = message.result?.result?.value;
			if (typeof value?.present !== 'boolean') {
				reject(new Error('The offscreen media session state was unavailable.'));
				return;
			}
			resolve(value);
		};
		cdp.on('Target.receivedMessageFromTarget', listener);
	});
	try {
		await cdp.send('Target.sendMessageToTarget', {
			sessionId,
			message: JSON.stringify({
				id: messageId,
				method: 'Runtime.evaluate',
				params: {
					expression: `(() => {
						const s = navigator.mediaSession;
						const debug = globalThis.__readitPlaybackDebug ? globalThis.__readitPlaybackDebug().mediaSession : null;
						return {
							present: !!s,
							playbackState: s ? s.playbackState : null,
							hasMetadata: !!(s && s.metadata),
							title: s && s.metadata ? s.metadata.title : null,
							artist: s && s.metadata ? s.metadata.artist : null,
							album: s && s.metadata ? s.metadata.album : null,
							registered: debug ? debug.registered : [],
							positionStateError: debug ? debug.positionStateError : null,
							lastPosition: debug ? debug.lastPosition : null,
						};
					})()`,
					returnByValue: true,
				},
			}),
		});
		return await result;
	} finally {
		await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
	}
}

test('the offscreen document holds a populated media session while an article plays', async ({ context, page, openSidePanel }) => {
	test.setTimeout(120_000);
	await context.route('https://en.wikipedia.org/**', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!DOCTYPE html><html><head><title>Speech synthesis - Wikipedia</title></head><body><main id="content"><h1>Speech synthesis</h1><p>Speech synthesis is a computer-generated simulation of human speech. It converts written text into spoken words for reading web pages aloud.</p></main></body></html>',
		});
	});

	await page.goto('https://en.wikipedia.org/wiki/Speech_synthesis');
	await page.waitForLoadState('networkidle');

	const sidePanel = await context.newPage();
	await openSidePanel(sidePanel);
	await page.bringToFront();

	await sidePanel.evaluate(() => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE' }));

	await expect
		.poll(
			async () =>
				await sidePanel.evaluate(async () => {
					const res = await chrome.storage.session.get('readit_playback_session');
					return (res as Record<string, { status?: string }>).readit_playback_session?.status ?? null;
				}),
			{ timeout: 60000 },
		)
		.toBe('playing');

	const probe = await readOffscreenMediaSession(context, page);

	expect(probe.present).toBe(true);
	expect(probe.playbackState).toBe('playing');
	expect(probe.hasMetadata).toBe(true);
	expect(probe.title).toBe('Speech synthesis');
	expect(probe.artist).toBe('en.wikipedia.org');
	expect(probe.album).toBe('readit.dev');
	expect(probe.registered).toEqual(expect.arrayContaining(['play', 'pause', 'stop']));

	// Chrome rejects a position state it dislikes with a TypeError the page never sees,
	// so assert it was accepted rather than merely attempted.
	expect(probe.positionStateError).toBeNull();
	expect(probe.lastPosition).not.toBeNull();
	expect(probe.lastPosition?.duration).toBeGreaterThan(0);
	expect(probe.lastPosition?.position).toBeLessThanOrEqual(probe.lastPosition?.duration ?? 0);

	// Sampled again across several paragraph boundaries: 'loading' fires at each one, and
	// a session that drops to 'none' mid-article is one the OS stops showing.
	for (const waitMs of [3000, 3000, 3000]) {
		await sidePanel.waitForTimeout(waitMs);
		const later = await readOffscreenMediaSession(context, page);
		expect(later.playbackState).not.toBe('none');
		expect(later.hasMetadata).toBe(true);
	}
});
