import type { BrowserContext, Page } from '@playwright/test';

import { expect, test } from './fixtures';

const targetUrl = 'https://readit.test/selection-button';
const hostSelector = '#readit-dev-selection-button-host';
const buttonSelector = `${hostSelector} button`;

async function openSelectionPage(context: BrowserContext): Promise<Page> {
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="vi"><head><title>Selection page</title></head><body style="min-height:1400px">
				<button id="before">Before selection</button>
				<p id="first">Đoạn văn bản đầu tiên dùng để kiểm tra nút đọc selection.</p>
				<p id="second">Đoạn văn bản thứ hai phải thay thế phiên đọc đang hoạt động.</p>
				<button id="outside-preserve" onpointerdown="event.preventDefault()">Dismiss without clearing selection</button>
				<input id="input" value="Input selection must not show the affordance." />
				<textarea id="textarea">Textarea selection must not show the affordance.</textarea>
				<div id="editable" contenteditable="true">Vùng soạn thảo không được hiển thị nút đọc.</div>
				<iframe id="child" srcdoc="<p id='inside-frame'>Văn bản trong iframe không thuộc phạm vi hỗ trợ.</p>"></iframe>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
	return page;
}

async function selectNodeText(page: Page, selector: string, source: 'pointer' | 'keyboard'): Promise<void> {
	await page.locator(selector).evaluate((element, selectionSource) => {
		const selection = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(element);
		selection?.removeAllRanges();
		selection?.addRange(range);
		if (selectionSource === 'pointer') {
			document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		} else {
			document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
		}
	}, source);
}

test('shows the approved logo button for pointer selection and hides it on dismissal events', async ({ context }) => {
	const page = await openSelectionPage(context);
	await selectNodeText(page, '#first', 'pointer');

	const button = page.locator(buttonSelector);
	await expect(button).toBeVisible();
	await expect(button).toHaveAttribute('aria-label', 'Đọc văn bản đã chọn');
	await expect(button.locator('img')).toHaveAttribute('src', /chrome-extension:\/\/.*\/assets\/icon32\.png/);
	await expect(button).toHaveCSS('width', '36px');
	await expect(button).toHaveCSS('height', '36px');

	await page.keyboard.press('Escape');
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await selectNodeText(page, '#first', 'pointer');
	await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await selectNodeText(page, '#first', 'pointer');
	await page.evaluate(() => window.dispatchEvent(new Event('resize')));
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await selectNodeText(page, '#first', 'pointer');
	await page.evaluate(() => window.getSelection()?.removeAllRanges());
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await selectNodeText(page, '#first', 'pointer');
	await page.mouse.click(4, 4);
	await expect(page.locator(hostSelector)).toHaveCount(0);
});

test('outside dismissal suppresses only the pointer sequence that removed the button', async ({ context }) => {
	const page = await openSelectionPage(context);
	await selectNodeText(page, '#first', 'pointer');
	await expect(page.locator(buttonSelector)).toBeVisible();

	await page.locator('#outside-preserve').click();
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await selectNodeText(page, '#second', 'pointer');
	await expect(page.locator(buttonSelector)).toBeVisible();
});

test('removes the stale button when selection changes without another activation event', async ({ context }) => {
	const page = await openSelectionPage(context);
	await selectNodeText(page, '#first', 'keyboard');
	await expect(page.locator(buttonSelector)).toBeFocused();

	await page.locator('#second').evaluate((element) => {
		const selection = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(element);
		selection?.removeAllRanges();
		selection?.addRange(range);
	});

	await expect(page.locator(hostSelector)).toHaveCount(0);
});

test('does not show the affordance for editable content', async ({ context }) => {
	const page = await openSelectionPage(context);
	await selectNodeText(page, '#editable', 'pointer');
	await expect(page.locator(hostSelector)).toHaveCount(0);
});

for (const [editableName, selector] of [
	['input', '#input'],
	['textarea', '#textarea'],
] as const) {
	test(`does not show the affordance for ${editableName} value selection`, async ({ context }) => {
		const page = await openSelectionPage(context);
		await page.locator(selector).evaluate((element) => {
			const editable = element as HTMLInputElement | HTMLTextAreaElement;
			editable.focus();
			editable.setSelectionRange(0, editable.value.length);
			editable.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		});

		await expect(page.locator(hostSelector)).toHaveCount(0);
	});
}

for (const [editableName, selector] of [
	['input', '#input'],
	['textarea', '#textarea'],
] as const) {
	test(`ControlOrMeta+A keeps a retained page selection hidden while ${editableName} is focused`, async ({ context }) => {
		const page = await openSelectionPage(context);
		await selectNodeText(page, '#first', 'pointer');
		await expect(page.locator(buttonSelector)).toBeVisible();

		const editable = page.locator(selector);
		await editable.evaluate((element) => {
			const valueControl = element as HTMLInputElement | HTMLTextAreaElement;
			valueControl.focus();
			valueControl.setSelectionRange(0, valueControl.value.length);

			const retainedText = document.querySelector('#first');
			const pageSelection = window.getSelection();
			const retainedRange = document.createRange();
			retainedRange.selectNodeContents(retainedText as Element);
			pageSelection?.removeAllRanges();
			pageSelection?.addRange(retainedRange);
		});
		await expect(editable).toBeFocused();
		await page.keyboard.press('ControlOrMeta+A');

		await expect(page.locator(hostSelector)).toHaveCount(0);
		await expect(editable).toBeFocused();
	});
}

test('does not install the affordance in child frames', async ({ context }) => {
	const page = await openSelectionPage(context);
	const frame = page.frameLocator('#child');
	await frame.locator('#inside-frame').evaluate((element) => {
		const selection = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(element);
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
	});
	await expect(frame.locator(hostSelector)).toHaveCount(0);
	await expect(page.locator(hostSelector)).toHaveCount(0);
});

test('keyboard selection focuses the button and Escape restores prior focus', async ({ context }) => {
	const page = await openSelectionPage(context);
	await page.locator('#before').focus();
	await selectNodeText(page, '#first', 'keyboard');

	await expect(page.locator(buttonSelector)).toBeFocused();
	await page.locator(buttonSelector).press('Escape');
	await expect(page.locator(hostSelector)).toHaveCount(0);
	await expect(page.locator('#before')).toBeFocused();
});

test('ControlOrMeta+A selection shows and focuses the button', async ({ context }) => {
	const page = await openSelectionPage(context);
	await page.locator('#before').focus();
	await page.keyboard.press('ControlOrMeta+A');

	await expect(page.locator(buttonSelector)).toBeFocused();
});

test('keyboard selection supports native Enter and Space activation', async ({ context }) => {
	const page = await openSelectionPage(context);

	await selectNodeText(page, '#first', 'keyboard');
	await page.locator(buttonSelector).press('Enter');
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await selectNodeText(page, '#second', 'keyboard');
	await page.locator(buttonSelector).press('Space');
	await expect(page.locator(hostSelector)).toHaveCount(0);
});

test('opens the action popup and replaces the active session with a new selection', async ({ context, extensionId }) => {
	const page = await openSelectionPage(context);
	const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`;
	const statePage = await context.newPage();
	await statePage.goto(`${popupUrl}?e2e-state`);
	await page.bringToFront();
	const cdp = await context.newCDPSession(page);
	const getActionPopupTargetIds = async () => {
		const { targetInfos } = await cdp.send('Target.getTargets');
		return targetInfos.filter((target) => target.type === 'page' && target.url === popupUrl).map((target) => target.targetId);
	};

	await selectNodeText(page, '#first', 'pointer');
	await page.locator(buttonSelector).click();
	await expect.poll(getActionPopupTargetIds).toHaveLength(1);
	const firstState = await statePage.evaluate(
		() => new Promise<any>((resolve) => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, resolve)),
	);
	expect(firstState.session).toMatchObject({
		contentScope: 'selection',
		source: { kind: 'tab', title: 'Selection page' },
		status: 'loading',
	});

	await page.bringToFront();
	await selectNodeText(page, '#second', 'pointer');
	await page.locator(buttonSelector).click();
	await expect.poll(getActionPopupTargetIds).toHaveLength(1);
	const secondState = await statePage.evaluate(
		() => new Promise<any>((resolve) => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, resolve)),
	);
	expect(secondState.session).toMatchObject({
		contentScope: 'selection',
		source: { kind: 'tab', title: 'Selection page' },
		status: 'loading',
	});
	expect(secondState.session.sessionId).not.toBe(firstState.session.sessionId);

	await statePage.evaluate((oldSessionId) => {
		chrome.runtime.sendMessage({
			action: 'PLAYBACK_PROGRESS_UPDATE',
			sessionId: oldSessionId,
			progress: { status: 'playing', currentParagraphIndex: 99, totalParagraphs: 100, progressPercentage: 99 },
		});
	}, firstState.session.sessionId);
	const stateAfterStaleProgress = await statePage.evaluate(
		() => new Promise<any>((resolve) => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, resolve)),
	);
	expect(stateAfterStaleProgress.session.sessionId).toBe(secondState.session.sessionId);
	expect(stateAfterStaleProgress.session.currentParagraphIndex).not.toBe(99);

	const persistedState = await statePage.evaluate(async () => ({
		local: await chrome.storage.local.get(),
		session: await chrome.storage.session.get(),
	}));
	expect(JSON.stringify(persistedState)).not.toContain('Đoạn văn bản thứ hai phải thay thế phiên đọc đang hoạt động.');
});

test('accepts only the first activation from the same rendered button', async ({ context, extensionId }) => {
	const page = await openSelectionPage(context);
	const observer = await context.newPage();
	await observer.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await observer.evaluate(() => {
		(window as any).selectedTextStartCount = 0;
		chrome.runtime.onMessage.addListener((message) => {
			if (message?.action === 'START_SELECTED_TEXT') {
				(window as any).selectedTextStartCount += 1;
			}
		});
	});

	await page.bringToFront();
	await selectNodeText(page, '#first', 'pointer');
	await page.locator(buttonSelector).evaluate((button) => {
		(button as HTMLButtonElement).click();
		(button as HTMLButtonElement).click();
	});

	await expect.poll(() => observer.evaluate(() => (window as any).selectedTextStartCount)).toBe(1);
	await page.waitForTimeout(150);
	expect(await observer.evaluate(() => (window as any).selectedTextStartCount)).toBe(1);
});

test('popup setting disables and re-enables the affordance in an open tab', async ({ context, extensionId }) => {
	const page = await openSelectionPage(context);
	const popup = await context.newPage();
	await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	const toggle = popup.getByRole('checkbox', { name: 'Hiện nút đọc cạnh văn bản đã chọn' });
	const getPlaybackState = () =>
		popup.evaluate(() => new Promise<any>((resolve) => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, resolve)));

	await page.bringToFront();
	await selectNodeText(page, '#first', 'pointer');
	await expect(page.locator(buttonSelector)).toBeVisible();

	await popup.bringToFront();
	await toggle.uncheck();
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await popup.bringToFront();
	await toggle.check();
	await page.bringToFront();
	await selectNodeText(page, '#first', 'pointer');
	await expect(page.locator(buttonSelector)).toBeVisible();
	await page.locator(buttonSelector).click();

	await expect.poll(async () => (await getPlaybackState()).session?.sessionId).toBeTruthy();
	const activeState = await getPlaybackState();
	expect(activeState.session).toMatchObject({
		contentScope: 'selection',
		source: { kind: 'tab', title: 'Selection page' },
		status: 'loading',
	});
	const activeSessionId = activeState.session.sessionId;

	await popup.bringToFront();
	await toggle.uncheck();
	await expect.poll(async () => (await getPlaybackState()).session?.sessionId).toBe(activeSessionId);

	await toggle.check();
	await page.bringToFront();
	await selectNodeText(page, '#second', 'pointer');
	await expect(page.locator(buttonSelector)).toBeVisible();
});

test.describe('English browser locale', () => {
	test.use({ browserLocale: 'en-US' });

	test('localizes the selected-text button label', async ({ context }) => {
		const page = await openSelectionPage(context);
		await selectNodeText(page, '#first', 'pointer');
		await expect(page.locator(buttonSelector)).toHaveAttribute('aria-label', 'Read selected text');
	});
});
