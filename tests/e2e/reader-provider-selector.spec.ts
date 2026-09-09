// The reader surface shipped without an engine control, so it listed on-device voice names while
// edge-tts was doing the speaking. These pin the two controls it grew, and the fallback that made
// the original bug so easy to miss.
import type { Page } from '@playwright/test';

import { buildDocxFixture } from './docx_fixture';
import { expect, test } from './fixtures';
import { stubFilePicker, stubPlaybackRuntime } from './reader_stubs';

/** Long enough for language detection to settle on Vietnamese, which Microsoft has voices for. */
const VIETNAMESE = Array.from(
	{ length: 6 },
	(_, index) =>
		`Đoạn ${index}. Trí tuệ nhân tạo đang thay đổi cách con người tiếp cận tri thức mỗi ngày, ` +
		'và nhiều công cụ mới ra đời khiến việc theo kịp trở nên khó khăn hơn trước rất nhiều.',
);
/** Lorem-style filler that detection cannot place, so it reports the undetermined code. */
const UNDETERMINED = Array.from({ length: 4 }, (_, index) => `Paragraph ${index} ${'sample text '.repeat(20)}`);

const ON_DEVICE_NAME = /Nam \d|Nữ \d|Male \d|Female \d/u;

async function openReader(page: Page, extensionId: string, paragraphs: string[], provider: string) {
	await stubFilePicker(page, 'fixture.docx', await buildDocxFixture(paragraphs));
	await stubPlaybackRuntime(page);
	await page.addInitScript((storedProvider) => {
		const original = chrome.storage.local.get.bind(chrome.storage.local);
		// The reader reads its engine and voice preferences once, on mount.
		(chrome.storage.local as unknown as { get: unknown }).get = (
			keys: string | string[],
			callback?: (items: Record<string, unknown>) => void,
		) => {
			if (callback) {
				callback({ readit_tts_provider: storedProvider });
				return undefined;
			}
			return original(keys as string);
		};
	}, provider);
	await page.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
	await page.locator('.btn-open-book').click();
	await expect(page.locator('.document-reader-content')).toContainText('0');
}

test('lists the cloud voices when edge-tts is selected and covers the language', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReader(reader, extensionId, VIETNAMESE, 'edge');

	await expect(reader.locator('#reader-tts-provider-select')).toHaveValue('edge');
	const voices = await reader.locator('#reader-voice-select option').allTextContents();
	expect(voices.length).toBeGreaterThan(0);
	expect(voices.some((name) => ON_DEVICE_NAME.test(name))).toBe(false);
});

test('lists the on-device voices when that engine is selected', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReader(reader, extensionId, VIETNAMESE, 'supertonic');

	await expect(reader.locator('#reader-tts-provider-select')).toHaveValue('supertonic');
	const voices = await reader.locator('#reader-voice-select option').allTextContents();
	expect(voices.some((name) => ON_DEVICE_NAME.test(name))).toBe(true);
});

// Picking edge-tts is not enough on its own: Microsoft has no voices for an undetermined language,
// and the session quietly runs on-device. Naming cloud voices here would name a voice nobody hears.
test('falls back to the on-device voices for a language the cloud does not cover', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReader(reader, extensionId, UNDETERMINED, 'edge');

	await expect(reader.locator('#reader-tts-provider-select')).toHaveValue('edge');
	const voices = await reader.locator('#reader-voice-select option').allTextContents();
	expect(voices.some((name) => ON_DEVICE_NAME.test(name))).toBe(true);
});

// The units in flight were planned for whichever engine started the session, so offering the
// choice mid-read would show a change the reader never hears.
test('locks both controls while the document is being read', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReader(reader, extensionId, VIETNAMESE, 'edge');

	await expect(reader.locator('#reader-tts-provider-select')).toBeDisabled();
	await expect(reader.locator('#reader-voice-select')).toBeDisabled();
});
