import type { PlaybackMetricsSummary } from '../../src/offscreen/playback_metrics.ts';
import type { AudioExportJobSnapshot, PlaybackStateResponse } from '../../src/shared/types.ts';
import { expect, installOpfsAudioExportPicker, opfsFileSizeOrNull, putOpfsAudioExportHandle, readOpfsFile, test } from './fixtures';
import { inspectMp3 } from './mp3';

test.use({ freshExtensionWorker: true });

async function getPlaybackState(page: import('@playwright/test').Page): Promise<PlaybackStateResponse> {
	return page.evaluate(() => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }) as Promise<PlaybackStateResponse>);
}

async function getAudioExportState(page: import('@playwright/test').Page) {
	return page.evaluate(() => chrome.runtime.sendMessage({ action: 'GET_AUDIO_EXPORT_STATE' }) as Promise<{ job: unknown }>);
}

async function getOffscreenRunwayDebug(
	context: import('@playwright/test').BrowserContext,
	page: import('@playwright/test').Page,
): Promise<{ backgroundSynthesisAllowed: boolean; sessionId: string | null }> {
	const cdp = await context.newCDPSession(page);
	const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
	const target = targetInfos.find((targetInfo) => targetInfo.url.includes('/src/offscreen/offscreen.html'));
	if (!target) {
		throw new Error('The offscreen playback document was unavailable.');
	}
	const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
	const messageId = 1;
	const result = new Promise<{ backgroundSynthesisAllowed: boolean; sessionId: string | null }>((resolve, reject) => {
		const listener = (event: { sessionId: string; message: string }) => {
			if (event.sessionId !== sessionId) {
				return;
			}
			const message = JSON.parse(event.message) as {
				id?: number;
				result?: { result?: { value?: { backgroundSynthesisAllowed?: boolean; sessionId?: string | null } } };
			};
			if (message.id !== messageId) {
				return;
			}
			cdp.off('Target.receivedMessageFromTarget', listener);
			const value = message.result?.result?.value;
			if (typeof value?.backgroundSynthesisAllowed !== 'boolean') {
				reject(new Error('The offscreen playback runway debug state was unavailable.'));
				return;
			}
			resolve({ backgroundSynthesisAllowed: value.backgroundSynthesisAllowed, sessionId: value.sessionId ?? null });
		};
		cdp.on('Target.receivedMessageFromTarget', listener);
	});
	try {
		await cdp.send('Target.sendMessageToTarget', {
			sessionId,
			message: JSON.stringify({
				id: messageId,
				method: 'Runtime.evaluate',
				params: { expression: 'globalThis.__readitPlaybackDebug?.()', returnByValue: true },
			}),
		});
		return await result;
	} finally {
		await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
	}
}

async function getOffscreenPlaybackMetrics(
	context: import('@playwright/test').BrowserContext,
	page: import('@playwright/test').Page,
): Promise<PlaybackMetricsSummary> {
	const cdp = await context.newCDPSession(page);
	const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
	const target = targetInfos.find((targetInfo) => targetInfo.url.includes('/src/offscreen/offscreen.html'));
	if (!target) {
		throw new Error('The offscreen playback document was unavailable.');
	}
	const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
	const messageId = 1;
	const result = new Promise<PlaybackMetricsSummary>((resolve, reject) => {
		const listener = (event: { sessionId: string; message: string }) => {
			if (event.sessionId !== sessionId) {
				return;
			}
			const message = JSON.parse(event.message) as { id?: number; result?: { result?: { value?: PlaybackMetricsSummary } } };
			if (message.id !== messageId) {
				return;
			}
			cdp.off('Target.receivedMessageFromTarget', listener);
			const value = message.result?.result?.value;
			if (!value || typeof value.totalUnits !== 'number') {
				reject(new Error('The offscreen playback metrics were unavailable.'));
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
				params: { expression: 'globalThis.__readitPlaybackMetrics?.()', returnByValue: true },
			}),
		});
		return await result;
	} finally {
		await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
	}
}

async function openRuntimeArticle(
	context: import('@playwright/test').BrowserContext,
	options: { path?: string; title?: string; body?: string; paragraphs?: string[] } = {},
) {
	const title = options.title ?? 'Runtime export article';
	const articleUrl = `https://readit.test/${options.path ?? 'audio-export-runtime'}`;
	const body =
		options.body ??
		'This short deterministic article verifies that the extension synthesizes locally and commits a real MP3 file through the browser origin private file system. A second sentence keeps synthesis active long enough for the cross-surface cancellation assertion.';
	const articleBody = options.paragraphs ? options.paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('') : `<p>${body}</p>`;
	await context.route(articleUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="en"><head><title>${title}</title></head><body><article><h1>${title}</h1>${articleBody}</article></body></html>`,
		}),
	);
	const article = await context.newPage();
	await article.goto(articleUrl, { waitUntil: 'domcontentloaded' });
	return article;
}

async function startRuntimeArticle(
	context: import('@playwright/test').BrowserContext,
	extensionId: string,
	page: import('@playwright/test').Page,
	options: { path?: string; title?: string; body?: string; paragraphs?: string[] } = {},
) {
	const article = await openRuntimeArticle(context, options);
	await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await article.bringToFront();
	await expect(page.evaluate(() => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE' }))).resolves.toEqual({ success: true });
	await expect
		.poll(
			async () => {
				const state = await getPlaybackState(page);
				return state.session?.status === 'playing' && state.session.audioExportEstimate ? state.session : null;
			},
			{ timeout: 240_000 },
		)
		.toMatchObject({ contentScope: 'article', audioExportEstimate: expect.any(Object) });
	return article;
}

function compactParagraphs(label: string, count: number): string[] {
	return Array.from(
		{ length: count },
		(_, index) => `${label} unit ${index + 1} is brief but keeps this distinct spoken test passage clear.`,
	);
}

test('returns the strict audio export snapshot shape to real extension clients', async ({ extensionId, page }) => {
	await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	expect(await getAudioExportState(page)).toEqual({ job: null });
});

test('writes a real local 96 kbps mono MP3 through the OPFS picker', async ({ context, extensionId, page, getRecordedRequests }) => {
	test.setTimeout(300_000);
	const outputName = 'runtime-article.mp3';
	await installOpfsAudioExportPicker(page, outputName);

	await startRuntimeArticle(context, extensionId, page);

	const estimate = (await getPlaybackState(page)).session?.audioExportEstimate;
	expect(estimate).toBeDefined();
	await expect(page.getByRole('button', { name: 'Xuất MP3' })).toBeEnabled();
	await page.getByRole('button', { name: 'Xuất MP3' }).click();
	await expect
		.poll(async () => (await getAudioExportState(page)).job as { state?: string } | null, { timeout: 60_000 })
		.toMatchObject({ state: expect.stringMatching(/exporting|waiting-for-playback/u) });
	await page.close();
	const reopened = await context.newPage();
	await reopened.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await expect
		.poll(async () => (await getAudioExportState(reopened)).job as { state?: string } | null, { timeout: 240_000 })
		.toMatchObject({ state: 'completed' });

	const bytes = await readOpfsFile(reopened, outputName);
	const inspection = inspectMp3(bytes);
	expect(inspection.frameCount).toBeGreaterThan(0);
	expect(inspection.bitrateKbps).toBe(96);
	expect(inspection.channelCount).toBe(1);
	const expectedDurationSeconds = estimate?.durationSeconds ?? 0;
	const durationToleranceSeconds = Math.max(5, expectedDurationSeconds * 0.6);
	expect(inspection.durationSeconds).toBeGreaterThan(expectedDurationSeconds - durationToleranceSeconds);
	expect(inspection.durationSeconds).toBeLessThan(expectedDurationSeconds + durationToleranceSeconds);
	await test.info().attach('mp3-duration.json', {
		body: JSON.stringify({
			actual: inspection.durationSeconds,
			expected: expectedDurationSeconds,
			tolerance: durationToleranceSeconds,
		}),
		contentType: 'application/json',
	});
	expect(
		getRecordedRequests().filter(
			(request) =>
				/^https?:/u.test(request.url) && /(lame|mediabunny|encoder|\.wasm(?:$|\?)|(?:cdn|unpkg|jsdelivr)\.)/iu.test(request.url),
		),
	).toEqual([]);
});

test('shares one job across Popup and Side Panel, then leaves no committed partial after cancellation', async ({
	context,
	extensionId,
	page,
}) => {
	test.setTimeout(300_000);
	const outputName = 'runtime-cancel.mp3';
	await installOpfsAudioExportPicker(page, outputName);
	await startRuntimeArticle(context, extensionId, page);
	const sidePanel = await context.newPage();
	await sidePanel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);
	await expect(sidePanel.locator('.audio-export-button')).toHaveCount(1);
	await page.getByRole('button', { name: 'Xuất MP3' }).click();
	await expect
		.poll(async () => (await getAudioExportState(page)).job as { state?: string } | null, { timeout: 30_000 })
		.toMatchObject({ state: expect.stringMatching(/exporting|waiting-for-playback/u) });
	await expect(sidePanel.getByRole('button', { name: 'Hủy xuất MP3' })).toBeVisible();
	await sidePanel.getByRole('button', { name: 'Hủy xuất MP3' }).click();
	await sidePanel.getByRole('button', { name: 'Hủy xuất MP3', exact: true }).last().click();
	await expect.poll(async () => (await getAudioExportState(sidePanel)).job, { timeout: 30_000 }).toBeNull();
	const size = await opfsFileSizeOrNull(sidePanel, outputName);
	expect(size === null || size === 0).toBe(true);
});

test('reports a failed export and no committed partial when the selected OPFS handle is not a file', async ({
	context,
	extensionId,
	page,
}) => {
	test.setTimeout(300_000);
	const outputName = 'runtime-write-failure.mp3';
	await installOpfsAudioExportPicker(page, outputName, { invalidHandleKind: 'directory' });
	await startRuntimeArticle(context, extensionId, page);
	await page.getByRole('button', { name: 'Xuất MP3' }).click();
	await expect
		.poll(async () => (await getAudioExportState(page)).job as { state?: string } | null, { timeout: 60_000 })
		.toMatchObject({ state: 'failed' });
	expect(await opfsFileSizeOrNull(page, outputName)).toBeNull();
	await expect(page.getByRole('button', { name: 'Xuất MP3' })).toBeEnabled();
});

test('keeps export A immutable while playback B temporarily consumes the synthesis runway', async ({ context, extensionId, page }) => {
	test.setTimeout(300_000);
	const outputName = 'replacement-a.mp3';
	const titleA = 'Export A immutable source';
	const titleB = 'Playback B priority source';
	const suggestedOutputName = `${titleA}.mp3`;
	await installOpfsAudioExportPicker(page, outputName);
	await startRuntimeArticle(context, extensionId, page, {
		path: 'audio-export-replacement-a',
		title: titleA,
		paragraphs: compactParagraphs('Export A immutable source', 3),
	});
	const estimateA = (await getPlaybackState(page)).session?.audioExportEstimate;
	expect(estimateA).toBeDefined();
	const sessionA = (await getPlaybackState(page)).session;
	expect(sessionA?.sessionId).toEqual(expect.any(String));
	const jobId = crypto.randomUUID();
	await putOpfsAudioExportHandle(page, jobId, outputName);
	await expect(
		page.evaluate(
			({ jobId, outputFilename, playbackSessionId, title }) =>
				chrome.runtime.sendMessage({
					action: 'PREPARE_AUDIO_EXPORT',
					payload: { jobId, outputFilename, playbackSessionId, title },
				}),
			{ jobId, outputFilename: suggestedOutputName, playbackSessionId: sessionA?.sessionId as string, title: titleA },
		),
	).resolves.toEqual({ success: true });
	await expect(page.evaluate(() => chrome.runtime.sendMessage({ action: 'PAUSE_READING' }))).resolves.toEqual({ success: true });
	await expect.poll(async () => (await getPlaybackState(page)).session?.status).toBe('paused');
	expect(await getOffscreenRunwayDebug(context, page)).toMatchObject({
		backgroundSynthesisAllowed: false,
		sessionId: sessionA?.sessionId,
	});
	await expect(
		page.evaluate((jobId) => chrome.runtime.sendMessage({ action: 'START_AUDIO_EXPORT', payload: { jobId } }), jobId),
	).resolves.toEqual({ success: true });
	await expect
		.poll(async () => (await getAudioExportState(page)).job as AudioExportJobSnapshot | null, { timeout: 60_000 })
		.toMatchObject({ jobId, title: titleA, outputFilename: suggestedOutputName, state: 'waiting-for-playback' });
	const exportA = (await getAudioExportState(page)).job as AudioExportJobSnapshot;

	const articleB = await openRuntimeArticle(context, {
		path: 'audio-export-replacement-b',
		title: titleB,
		paragraphs: compactParagraphs('Playback B priority source', 3),
	});
	await articleB.bringToFront();
	await expect(page.evaluate(() => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE' }))).resolves.toEqual({ success: true });
	await expect
		.poll(
			async () => {
				const session = (await getPlaybackState(page)).session;
				return session?.source.title === titleB ? session.status : null;
			},
			{ timeout: 240_000 },
		)
		.toBe('loading');
	await expect
		.poll(async () => (await getAudioExportState(page)).job as AudioExportJobSnapshot | null, { timeout: 60_000 })
		.toMatchObject({ jobId: exportA.jobId, state: 'waiting-for-playback' });
	await expect
		.poll(
			async () => {
				const session = await getPlaybackState(page);
				const runway = await getOffscreenRunwayDebug(context, page);
				return (
					session.session?.source.title === titleB && session.session.status === 'playing' && runway.backgroundSynthesisAllowed
				);
			},
			{ timeout: 240_000 },
		)
		.toBe(true);
	await expect
		.poll(async () => (await getAudioExportState(page)).job as AudioExportJobSnapshot | null, { timeout: 240_000 })
		.toMatchObject({ jobId: exportA.jobId, state: 'exporting' });
	await expect
		.poll(
			async () => {
				const metrics = await getOffscreenPlaybackMetrics(context, page);
				return metrics.totalUnits !== null && metrics.totalUnits > 1 && metrics.unitsStarted === metrics.totalUnits
					? metrics
					: null;
			},
			{ timeout: 240_000 },
		)
		.toMatchObject({ totalUnits: expect.any(Number), unitsStarted: expect.any(Number) });
	const metrics = await getOffscreenPlaybackMetrics(context, page);
	expect(metrics.unitSequence).toEqual(Array.from({ length: metrics.unitsStarted }, (_, index) => index));
	expect(metrics.skippedUnits).toEqual([]);
	expect(metrics.repeatedUnits).toEqual([]);
	expect(metrics.droppedStarts).toEqual([]);
	expect(metrics.synthErrors).toEqual([]);
	expect(metrics.gapsOverThreshold).toBe(0);
	await expect
		.poll(async () => (await getAudioExportState(page)).job as AudioExportJobSnapshot | null, { timeout: 240_000 })
		.toMatchObject({ jobId: exportA.jobId, title: titleA, outputFilename: suggestedOutputName, state: 'completed' });

	const inspection = inspectMp3(await readOpfsFile(page, outputName));
	const durationToleranceSeconds = Math.max(5, (estimateA?.durationSeconds ?? 0) * 0.6);
	expect(inspection.durationSeconds).toBeGreaterThan((estimateA?.durationSeconds ?? 0) - durationToleranceSeconds);
	expect(inspection.durationSeconds).toBeLessThan((estimateA?.durationSeconds ?? 0) + durationToleranceSeconds);
});
