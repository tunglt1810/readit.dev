import { expect, test } from './fixtures';

test.describe('Playlist Queue', () => {
	test.beforeEach(async ({ context }) => {
		await context.route('https://en.wikipedia.org/**', (route) => {
			const url = route.request().url();
			const title = url.includes('Podcast') ? 'Podcast - Wikipedia' : 'Speech synthesis - Wikipedia';
			const heading = url.includes('Podcast') ? 'Podcast' : 'Speech synthesis';
			void route.fulfill({
				status: 200,
				contentType: 'text/html',
				body: `<!DOCTYPE html><html><head><title>${title}</title></head><body><main id="content"><h1>${heading}</h1><p>Speech synthesis is a computer-generated simulation of human speech. It is used to convert written text into spoken words in applications like Readit for reading web pages and documents aloud efficiently.</p></main></body></html>`,
			});
		});
		const workers = context.serviceWorkers();
		const worker = workers[0];
		if (worker) {
			await worker.evaluate(async () => {
				await chrome.storage.local.remove('readit_playlist_queue');
			});
		}
	});

	test('add current tab to queue shows item in side panel', async ({ context, page, openSidePanel }) => {
		await page.goto('https://en.wikipedia.org/wiki/Text_to_speech');
		await page.waitForLoadState('networkidle');

		const sidePanel = await context.newPage();
		await openSidePanel(sidePanel);

		await page.bringToFront();
		await sidePanel.locator('button:has-text("+ Thêm tab hiện tại")').click();

		const queueList = sidePanel.locator('.queue-list');
		await expect(queueList.locator('.queue-item')).toHaveCount(1);
		await expect(queueList.locator('.queue-item-title')).toContainText('Speech synthesis');
	});

	test('add duplicate URL shows error', async ({ context, page, openSidePanel }) => {
		await page.goto('https://en.wikipedia.org/wiki/Text_to_speech');
		await page.waitForLoadState('networkidle');

		const sidePanel = await context.newPage();
		await openSidePanel(sidePanel);

		await page.bringToFront();
		await sidePanel.locator('button:has-text("+ Thêm tab hiện tại")').click();
		await expect(sidePanel.locator('.queue-item')).toHaveCount(1);

		await sidePanel.locator('button:has-text("+ Thêm tab hiện tại")').click();

		await expect(sidePanel.locator('.queue-error')).toBeVisible();
		await expect(sidePanel.locator('.queue-error')).toHaveText('URL này đã có trong queue.');
		await expect(sidePanel.locator('.queue-item')).toHaveCount(1);
	});

	test('add URL manually via input', async ({ page, openSidePanel }) => {
		await openSidePanel(page);

		const input = page.locator('.queue-url-input');
		await input.fill('https://en.wikipedia.org/wiki/Podcast');
		await page.locator('.queue-url-row button:has-text("Thêm")').click();

		await expect(page.locator('.queue-item')).toHaveCount(1);
		await expect(page.locator('.queue-item-host')).toContainText('en.wikipedia.org');
	});

	test('remove pending item from queue', async ({ page, openSidePanel }) => {
		await openSidePanel(page);

		const input = page.locator('.queue-url-input');
		await input.fill('https://en.wikipedia.org/wiki/Podcast');
		await page.locator('.queue-url-row button:has-text("Thêm")').click();

		await expect(page.locator('.queue-item')).toHaveCount(1);

		await page.locator('.queue-remove-btn').click();
		await expect(page.locator('.queue-item')).toHaveCount(0);
	});

	test('clear queue removes all items', async ({ page, openSidePanel }) => {
		await openSidePanel(page);

		await page.locator('.queue-url-input').fill('https://en.wikipedia.org/wiki/Podcast');
		await page.locator('.queue-url-row button:has-text("Thêm")').click();
		await expect(page.locator('.queue-item')).toHaveCount(1);

		await page.locator('.queue-url-input').fill('https://en.wikipedia.org/wiki/Radio');
		await page.locator('.queue-url-row button:has-text("Thêm")').click();
		await expect(page.locator('.queue-item')).toHaveCount(2);

		await page.locator('button:has-text("Xóa tất cả")').click();
		await expect(page.locator('.queue-item')).toHaveCount(0);
	});

	test('queue persists after side panel reload', async ({ page, openSidePanel }) => {
		await openSidePanel(page);

		await page.locator('.queue-url-input').fill('https://en.wikipedia.org/wiki/Podcast');
		await page.locator('.queue-url-row button:has-text("Thêm")').click();
		await expect(page.locator('.queue-item')).toHaveCount(1);

		await page.reload();

		await expect(page.locator('.queue-item')).toHaveCount(1);
		await expect(page.locator('.queue-item-host')).toContainText('en.wikipedia.org');
	});

	test('queue item shows pending status and stats counter', async ({ page, openSidePanel }) => {
		await openSidePanel(page);

		await page.locator('.queue-url-input').fill('https://en.wikipedia.org/wiki/Text_to_speech');
		await page.locator('.queue-url-row button:has-text("Thêm")').click();

		await expect(page.locator('.queue-item')).toHaveCount(1);
		await expect(page.locator('.queue-item[data-status="pending"]')).toHaveCount(1);
		// Stats show 0 done / 1 total in queue header next to title
		await expect(page.locator('.queue-header .queue-stats')).toContainText('0/1');
	});

	test('play queue button uses primary-button class for theme consistency', async ({ page, openSidePanel }) => {
		await openSidePanel(page);

		await page.locator('.queue-url-input').fill('https://en.wikipedia.org/wiki/Text_to_speech');
		await page.locator('.queue-url-row button:has-text("Thêm")').click();

		const playBtn = page.locator('.queue-play-btn');
		await expect(playBtn).toHaveClass(/primary-button/);
	});

	test('auto-advance from web page to local PDF file without error or crash', async ({ context, page, openSidePanel }) => {
		const fs = await import('fs');
		const path = await import('path');
		const tmpDir = path.resolve(process.cwd(), '.tmp');
		fs.mkdirSync(tmpDir, { recursive: true });
		const pdfPath = path.join(tmpDir, 'e2e_test_doc.pdf');
		const pdfContent = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length 44 >> stream
BT /F1 12 Tf 72 712 Td (Hello PDF Queue World) Tj ET
endstream endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000223 00000 n 
0000000290 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
383
%%EOF`;
		fs.writeFileSync(pdfPath, pdfContent);
		const fileUrl = `file://${pdfPath.startsWith('/') ? '' : '/'}${pdfPath.replace(/\\/g, '/')}`;

		await page.goto('https://en.wikipedia.org/wiki/Text_to_speech');
		await page.waitForLoadState('networkidle');

		context.on('serviceworker', (sw) => {
			sw.on('console', (msg) => console.log('[SW CONSOLE]:', msg.text()));
		});

		const sidePanel = await context.newPage();
		await openSidePanel(sidePanel);

		await page.bringToFront();
		await sidePanel.locator('.queue-add-tab-btn').click();
		await expect(sidePanel.locator('.queue-item')).toHaveCount(1);

		await sidePanel.locator('.queue-url-input').fill(fileUrl);
		await sidePanel.locator('.queue-url-row button').click();
		await expect(sidePanel.locator('.queue-item')).toHaveCount(2);

		const workers = context.serviceWorkers();
		const worker = workers[0];
		if (worker) {
			await worker.evaluate(() => {
				if (chrome.extension) {
					chrome.extension.isAllowedFileSchemeAccess = (cb: (isAllowed: boolean) => void) => cb(true);
				}
			});
		}

		await sidePanel.locator('.queue-play-btn').click();
		await expect(sidePanel.locator('.queue-item[data-status="playing"]')).toHaveCount(1);

		let activeSessionId: string | null = null;
		if (worker) {
			await expect
				.poll(
					async () => {
						activeSessionId = await worker.evaluate(async () => {
							const res = await chrome.storage.session.get('readit_playback_session');
							return (res as Record<string, { sessionId?: string }>).readit_playback_session?.sessionId ?? null;
						});
						return activeSessionId;
					},
					{ timeout: 30000 },
				)
				.not.toBeNull();
		}
		await expect
			.poll(
				async () => {
					const result = await worker?.evaluate(async () => {
						const res = await chrome.storage.session.get('readit_playback_session');
						return (res as Record<string, { status?: string }>).readit_playback_session?.status ?? null;
					});
					return result ?? null;
				},
				{ timeout: 30000 },
			)
			.toBe('playing');

		// Send message from sidePanel page context so background SW onMessage listener receives it
		await sidePanel.evaluate(async (sessionId) => {
			await chrome.runtime.sendMessage({
				action: 'PLAYBACK_PROGRESS_UPDATE',
				sessionId,
				progress: {
					status: 'stopped',
					completedNaturally: true,
					currentParagraphIndex: 0,
					totalParagraphs: 1,
					progressPercentage: 100,
				},
			});
		}, activeSessionId);
		await sidePanel.waitForTimeout(2000);

		await expect(sidePanel.locator('.queue-item').nth(1)).toHaveAttribute('data-status', 'playing', { timeout: 10000 });
		await expect(sidePanel.locator('.queue-item[data-status="error"]')).toHaveCount(0);
	});

	// markPlaying runs before the session exists, so a queue item showing 'playing' is
	// not yet a signal that there is anything to skip.
	async function waitForActiveSessionPlaying(context: import('@playwright/test').BrowserContext): Promise<void> {
		const worker = context.serviceWorkers()[0];
		await expect
			.poll(
				async () =>
					(await worker?.evaluate(async () => {
						const res = await chrome.storage.session.get('readit_playback_session');
						return (res as Record<string, { status?: string }>).readit_playback_session?.status ?? null;
					})) ?? null,
				{ timeout: 30000 },
			)
			.toBe('playing');
	}

	test('skip to next marks the current item done and starts the next', async ({ context, page, openSidePanel }) => {
		await page.goto('https://en.wikipedia.org/wiki/Text_to_speech');
		await page.waitForLoadState('networkidle');

		const sidePanel = await context.newPage();
		await openSidePanel(sidePanel);

		await page.bringToFront();
		await sidePanel.locator('.queue-add-tab-btn').click();
		await expect(sidePanel.locator('.queue-item')).toHaveCount(1);

		await sidePanel.locator('.queue-url-input').fill('https://en.wikipedia.org/wiki/Podcast');
		await sidePanel.locator('.queue-url-row button').click();
		await expect(sidePanel.locator('.queue-item')).toHaveCount(2);

		await sidePanel.locator('.queue-play-btn').click();
		await expect(sidePanel.locator('.queue-item').nth(0)).toHaveAttribute('data-status', 'playing', { timeout: 30000 });
		await waitForActiveSessionPlaying(context);

		const response = await sidePanel.evaluate(async () => {
			return await chrome.runtime.sendMessage({ action: 'SKIP_TO_NEXT_QUEUE_ITEM' });
		});
		expect(response).toMatchObject({ success: true });

		// The skipped item must land on 'done'. Reverting it to 'pending' is the
		// regression this guards: startPlayback -> stopActiveSession releases the
		// active session's queue item back to pending, which would overwrite the
		// markDone and make getNextPending pick the skipped article again.
		await expect(sidePanel.locator('.queue-item').nth(0)).toHaveAttribute('data-status', 'done', { timeout: 30000 });
		await expect(sidePanel.locator('.queue-item').nth(1)).toHaveAttribute('data-status', 'playing', { timeout: 30000 });
	});

	test('skip on the last item ends the queue without starting anything', async ({ context, page, openSidePanel }) => {
		await page.goto('https://en.wikipedia.org/wiki/Text_to_speech');
		await page.waitForLoadState('networkidle');

		const sidePanel = await context.newPage();
		await openSidePanel(sidePanel);

		await page.bringToFront();
		await sidePanel.locator('.queue-add-tab-btn').click();
		await expect(sidePanel.locator('.queue-item')).toHaveCount(1);

		await sidePanel.locator('.queue-play-btn').click();
		await expect(sidePanel.locator('.queue-item').nth(0)).toHaveAttribute('data-status', 'playing', { timeout: 30000 });
		await waitForActiveSessionPlaying(context);

		const response = await sidePanel.evaluate(async () => {
			return await chrome.runtime.sendMessage({ action: 'SKIP_TO_NEXT_QUEUE_ITEM' });
		});
		expect(response).toMatchObject({ success: true });

		await expect(sidePanel.locator('.queue-item').nth(0)).toHaveAttribute('data-status', 'done', { timeout: 30000 });
		await expect(sidePanel.locator('.queue-item[data-status="playing"]')).toHaveCount(0);
	});
});
