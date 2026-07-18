import type { BrowserContext, Page, Worker } from '@playwright/test';

import { tokenizeVietnameseText } from '../../src/offscreen/vietnamese/tokenizer';
import { expect, test } from './fixtures';

const highlightRegistryName = 'readit-dev-word-highlight';

type TestWordHighlightMessage =
	| { action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE'; sessionId: string; selectionText: string }
	| { action: 'WORD_HIGHLIGHT_UPDATE'; sessionId: string; word: string; contentScope?: 'article' | 'selection' }
	| { action: 'WORD_HIGHLIGHT_CLEAR'; sessionId: string };

function findExtensionServiceWorker(context: BrowserContext): Worker {
	const serviceWorker = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
	if (!serviceWorker) {
		throw new Error('Extension service worker was not found.');
	}
	return serviceWorker;
}

async function getTabId(serviceWorker: Worker): Promise<number> {
	// The extension has neither the "tabs" permission nor host permissions for the test
	// origin, so `chrome.tabs.query({ url })` cannot see (or match against) tab URLs here.
	// Querying by `active`/`currentWindow` doesn't require that permission and reliably
	// resolves to the page we just opened, since each test runs in its own fresh context.
	const tabId = await serviceWorker.evaluate(async () => {
		const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
		return tabs[0]?.id;
	});
	if (typeof tabId !== 'number') {
		throw new Error('Could not resolve the active tab id.');
	}
	return tabId;
}

async function sendWordHighlightMessage(serviceWorker: Worker, tabId: number, message: TestWordHighlightMessage): Promise<void> {
	// Fire-and-forget: this test only cares that the content script receives and processes the
	// message synchronously (verified via polling below), not about the sendMessage response.
	// (content_script.ts used to unconditionally return `true` from its top-level onMessage
	// listener, which kept the reply channel open for ~30s on actions it didn't handle — fixed
	// in a later commit — but this call stays fire-and-forget regardless, since it never needed
	// the response.)
	await serviceWorker.evaluate(
		({ id, msg }) => {
			void chrome.tabs.sendMessage(id, msg).catch(() => {});
		},
		{ id: tabId, msg: message },
	);
}

async function selectElementContentsAndOpenContextMenu(page: Page, selector: string): Promise<void> {
	await page.locator(selector).evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
	});
}

async function selectSubstring(page: Page, selector: string, target: string): Promise<void> {
	await page.locator(selector).evaluate((element, needle) => {
		const textNode = element.firstChild as Text;
		const start = textNode.textContent!.indexOf(needle);
		const range = document.createRange();
		range.setStart(textNode, start);
		range.setEnd(textNode, start + needle.length);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
	}, target);
}

async function currentHighlightText(page: Page): Promise<string | null> {
	return page.evaluate((name) => {
		const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
		const [range] = highlight ? [...highlight] : [];
		return range ? range.toString() : null;
	}, highlightRegistryName);
}

test('highlights the current word as WORD_HIGHLIGHT_UPDATE messages arrive, and clears on WORD_HIGHLIGHT_CLEAR', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="en"><head><title>Word highlight page</title></head><body>
				<article><p id="content">First sentence about testing.</p></article>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);

	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'e2e-session', word: 'First' });
	await expect.poll(() => currentHighlightText(page)).toBe('First');

	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'e2e-session', word: 'sentence' });
	await expect.poll(() => currentHighlightText(page)).toBe('sentence');

	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_CLEAR', sessionId: 'e2e-session' });
	await expect
		.poll(() =>
			page.evaluate((name) => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has(name), highlightRegistryName),
		)
		.toBe(false);
});

test('resolves a WORD_HIGHLIGHT_UPDATE round-trip quickly instead of stalling the message channel', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight-latency';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="en"><head><title>Latency page</title></head><body>
				<article><p id="content">Quick response check.</p></article>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);

	// Regression guard for the message-channel hang: content_script.ts's onMessage listener
	// must not return `true` for actions it doesn't handle, or Chrome keeps this channel open
	// for ~30s per message. Awaiting the response directly (racing a short timeout) turns that
	// class of regression into an immediate, unambiguous failure instead of a 30s test timeout.
	const resolvedInTime = await serviceWorker.evaluate(
		async ({ id, msg }) => {
			const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000));
			const response = chrome.tabs.sendMessage(id, msg).then(() => 'resolved' as const);
			return Promise.race([response, timeout]);
		},
		{ id: tabId, msg: { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'e2e-latency', word: 'Quick' } },
	);

	expect(resolvedInTime).toBe('resolved');
});

test('advances past a repeated word instead of matching the same earlier occurrence again', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight-repeat';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="en"><head><title>Repeat page</title></head><body>
				<article><p id="content">The cat sat on the mat.</p></article>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);

	for (const word of ['The', 'cat', 'sat', 'on', 'the']) {
		await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'e2e-repeat', word });
	}

	await expect
		.poll(() =>
			page.evaluate((name) => {
				const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
				const [range] = highlight ? [...highlight] : [];
				if (!range) {
					return null;
				}
				const following = range.startContainer.textContent?.slice(range.endOffset, range.endOffset + 4);
				return { matched: range.toString(), following };
			}, highlightRegistryName),
		)
		.toEqual({ matched: 'the', following: ' mat' });
});

test('anchors to the selected passage instead of an earlier occurrence of the same word when reading selected text', async ({
	context,
}) => {
	const targetUrl = 'https://readit.test/word-highlight-selection-anchor';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="en"><head><title>Selection anchor page</title></head><body>
				<article><p id="content">The cat sat on the mat. The dog ran away.</p></article>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	await selectSubstring(page, '#content', 'The dog ran away.');
	await page.locator('#readit-dev-selection-button-host button').click();

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);
	await expect
		.poll(() =>
			serviceWorker.evaluate(async () => {
				const stored = await chrome.storage.session.get('readit_playback_session');
				return (stored.readit_playback_session as { contentScope?: string } | undefined)?.contentScope ?? null;
			}),
		)
		.toBe('selection');
	const sessionId = await serviceWorker.evaluate(async () => {
		const stored = await chrome.storage.session.get('readit_playback_session');
		return (stored.readit_playback_session as { sessionId?: string } | undefined)?.sessionId;
	});
	if (!sessionId) {
		throw new Error('Selected-text playback session was not created.');
	}

	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_UPDATE',
		sessionId,
		word: 'The',
		contentScope: 'selection',
	});

	await expect
		.poll(() =>
			page.evaluate((name) => {
				const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
				const [range] = highlight ? [...highlight] : [];
				if (!range) {
					return null;
				}
				const following = range.startContainer.textContent?.slice(range.endOffset, range.endOffset + 4);
				return { matched: range.toString(), following };
			}, highlightRegistryName),
		)
		.toEqual({ matched: 'The', following: ' dog' });
});

test('keeps context-menu selected-text highlights inside the exact selected range', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight-context-menu-scope';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="vi"><body><article>
				<p id="caption">Ông Trần Minh Khoa xuất hiện trong chú thích ảnh.</p>
				<p id="selected"><span>Ông Trần Minh </span><strong>Khoa</strong> cho biết đơn vị hỗ trợ.</p>
			</article></body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
	await selectElementContentsAndOpenContextMenu(page, '#selected');

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);
	const sessionId = 'e2e-context-selection';
	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE',
		sessionId,
		selectionText: 'Ông Trần Minh Khoa cho biết đơn vị hỗ trợ.',
	});

	for (const word of ['Ông', 'Trần', 'Minh', 'Khoa']) {
		await sendWordHighlightMessage(serviceWorker, tabId, {
			action: 'WORD_HIGHLIGHT_UPDATE',
			sessionId,
			word,
			contentScope: 'selection',
		});
		await expect
			.poll(() =>
				page.evaluate((name) => {
					const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
					const [range] = highlight ? [...highlight] : [];
					return range?.startContainer.parentElement?.closest('[id]')?.id ?? null;
				}, highlightRegistryName),
			)
			.toBe('selected');
	}
});

test('clears instead of matching a word after the selected range', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight-selection-end';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: '<!doctype html><html lang="en"><body><article><p id="content">Selected words. Outside only.</p></article></body></html>',
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
	await selectSubstring(page, '#content', 'Selected words.');
	await page.locator('#content').dispatchEvent('contextmenu');

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);
	const sessionId = 'e2e-selection-end';
	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE',
		sessionId,
		selectionText: 'Selected words.',
	});
	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_UPDATE',
		sessionId,
		word: 'Selected',
		contentScope: 'selection',
	});
	await expect.poll(() => currentHighlightText(page)).toBe('Selected');

	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_UPDATE',
		sessionId,
		word: 'Outside',
		contentScope: 'selection',
	});
	await expect.poll(() => currentHighlightText(page)).toBeNull();
});

test('matches the target word against the DOM text regardless of NFC/NFD Unicode form', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight-unicode-form';
	const nfdParagraph = 'Việt Nam là một quốc gia tươi đẹp.'.normalize('NFD');
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="vi"><head><title>Unicode form page</title></head><body>
				<article><p id="content">${nfdParagraph}</p></article>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);

	// The TTS pipeline always sends NFC-normalized words (see vietnamese/tokenizer.ts), while this
	// page's own text is NFD — the content script must match across the Unicode form difference.
	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_UPDATE',
		sessionId: 'e2e-unicode-form',
		word: 'Việt'.normalize('NFC'),
	});

	await expect
		.poll(() =>
			page.evaluate((name) => {
				const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
				const [range] = highlight ? [...highlight] : [];
				return range ? range.toString().normalize('NFC') : null;
			}, highlightRegistryName),
		)
		.toBe('Việt');
});

test('finds words inside the article even when an outer layout wrapper coincidentally matches the noise pattern', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight-noise-false-positive';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			// "sidebar-1" is a real site's own main-content grid-column class name (vnexpress.net) —
			// it has nothing to do with an actual navigational sidebar, but isWithinNoiseRegion's
			// ancestor walk used to match it against the noise pattern and exclude the whole article.
			body: `<!doctype html><html lang="vi"><head><title>Noise false-positive page</title></head><body>
				<main>
					<div class="sidebar-1">
						<article>
							<h1 id="content">Tin tức thời sự hôm nay</h1>
							<p>Nội dung bài viết được đăng tải đầy đủ trên trang, gồm nhiều đoạn văn bản dài để đủ điều kiện được nhận diện là nội dung chính của trang, không phải một đoạn văn bản ngắn bị bỏ qua.</p>
						</article>
					</div>
				</main>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);

	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_UPDATE',
		sessionId: 'e2e-noise-false-positive',
		word: 'Tin',
	});

	await expect.poll(() => currentHighlightText(page)).toBe('Tin');
});

test('does not match a short word inside a longer unrelated word (no word-boundary check)', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight-substring-boundary';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			// "canô" literally contains "an" as a raw substring (c-AN-ô). A plain indexOf search for
			// "an" must not match inside it — it must skip ahead to the real standalone "an" word.
			body: `<!doctype html><html lang="vi"><head><title>Substring boundary page</title></head><body>
					<article><p id="content">Chiếc canô lật úp, rồi an toàn được đưa vào bờ.</p></article>
				</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);

	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_UPDATE',
		sessionId: 'e2e-substring-boundary',
		word: 'an',
	});

	await expect
		.poll(() =>
			page.evaluate((name) => {
				const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
				const [range] = highlight ? [...highlight] : [];
				if (!range) {
					return null;
				}
				const before = range.startContainer.textContent?.slice(Math.max(0, range.startOffset - 4), range.startOffset);
				return { matched: range.toString(), before };
			}, highlightRegistryName),
		)
		.toEqual({ matched: 'an', before: 'rồi ' });
});

test('a punctuation search target does not skip ahead past real words to reach a distant boundary-satisfying match', async ({
	context,
}) => {
	const targetUrl = 'https://readit.test/word-highlight-punctuation-target';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			// The nearby comma after "úp" is always letter-preceded ("úp,"), so it can never satisfy a
			// word-boundary-aware search — the only boundary-satisfying comma in this text is much
			// later, right after a closing quote. A punctuation search target must not skip ahead to
			// that distant comma and eat every real word in between (this should never happen in
			// practice since punctuation is excluded from the word map at the source — see
			// vietnamese/normalizer.ts — but this defends the content-script search itself too).
			body: `<!doctype html><html lang="vi"><head><title>Punctuation target page</title></head><body>
					<article><p id="content">Canô lật úp, số khác trôi trên biển. Anh nói "cứu", rồi lên tàu.</p></article>
				</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);

	for (const word of ['Canô', 'lật', 'úp', ',', 'số']) {
		await sendWordHighlightMessage(serviceWorker, tabId, {
			action: 'WORD_HIGHLIGHT_UPDATE',
			sessionId: 'e2e-punctuation-target',
			word,
		});
	}

	// "số" must highlight right after "úp," — not have been skipped past because the "," search
	// jumped ahead to the comma after the closing quote near "cứu".
	await expect.poll(() => currentHighlightText(page)).toBe('số');
});

test('recovers after a word split across inline markup instead of staying stuck for the rest of the session', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight-split-word';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="vi"><head><title>Split word page</title></head><body>
				<article><p id="content">Tăng <a href="#">họ</a>c phí nhanh</p></article>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);

	// "học" is split across the <a> boundary ("họ" + "c phí nhanh") so it can never match as a
	// single substring — this must not permanently disable highlighting for the words after it.
	for (const word of ['Tăng', 'học', 'phí', 'nhanh']) {
		await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'e2e-split-word', word });
	}

	await expect.poll(() => currentHighlightText(page)).toBe('nhanh');
});

test('highlights every real word of a realistic multi-paragraph Vietnamese article in order, with no dead zones', async ({ context }) => {
	// A comprehensive regression net: a single narrow scenario per test (as above) only catches the
	// one bug it was written for. This test walks a whole realistic article structure end to end —
	// a title, a location-stamp span glued directly to the next sentence with no DOM whitespace
	// (the exact vnexpress.net structure that caused the "GiangThấy" fusion bug), a word that is
	// also a raw substring of a longer word ("an" inside "canô", twice), a comma right after a
	// closing quote elsewhere in the text (the exact structure that caused the punctuation
	// skip-ahead bug), and a repeated word ("Lộc") — and asserts every single real word gets found
	// at its correct position, in order, with none silently skipped.
	const targetUrl = 'https://readit.test/word-highlight-full-article';
	const title = 'Nỗ lực cứu du khách lật canô ở Phú Quốc';
	// Mirrors getTextBlocks()'s post-fix output: a real space between the glued span and the
	// following sentence. The DOM itself (below) keeps them glued with zero whitespace, exactly
	// like the live site, so this also exercises the cross-node search boundary.
	const lead =
		'An Giang Thấy nhiều du khách Ấn Độ bám trên thân canô lật úp, số khác trôi trên biển Phú Quốc, anh Hà Văn Lộc cố lái tàu tiếp cận giữa sóng lớn.';
	const quote = '"Họ bị sóng nhấn chìm vẫn cố vẫy tay cầu cứu", thuyền trưởng Lộc, 44 tuổi, kể lại.';

	// Generate the real word sequence with the actual production tokenizer — punctuation-kind
	// tokens are excluded, mirroring vietnamese/normalizer.ts's wordMap filtering, since those are
	// never sent as highlight targets.
	const tokenized = tokenizeVietnameseText([title, lead, quote].join('\n\n'));
	const words = tokenized.paragraphs.flatMap((paragraph) =>
		paragraph.tokens.filter((token) => token.kind !== 'punctuation').map((token) => token.original),
	);
	expect(words.length).toBeGreaterThan(30);

	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="vi"><head><title>Full article page</title></head><body>
				<article>
					<h1 id="title">${title}</h1>
					<p id="lead"><span class="location-stamp">An Giang</span>Thấy nhiều du khách Ấn Độ bám trên thân canô lật úp, số khác trôi trên biển Phú Quốc, anh Hà Văn Lộc cố lái tàu tiếp cận giữa sóng lớn.</p>
					<p id="quote">${quote}</p>
				</article>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);

	for (const word of words) {
		await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'e2e-full-article', word });
		// Poll after every single word, not just the last one — a miss that happens to leave the
		// highlight on a plausible-looking earlier word would otherwise go unnoticed until a much
		// later assertion, if ever.
		await expect.poll(() => currentHighlightText(page), { message: `expected "${word}" to be highlighted` }).toBe(word);
	}
});
