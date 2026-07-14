import { expect, test } from './fixtures';

test('keeps Vietnamese extraction local and remains cancellable while models are pending', async ({ context, extensionId }) => {
	const articleUrl = 'https://readit.test/vietnamese-article';
	const remoteRequests: Array<{ url: string; body: string | null }> = [];
	const runtimeFiles = new Set<string>();
	context.on('request', (request) => {
		const url = request.url();
		if (/\.(?:mjs|wasm)(?:$|\?)/u.test(url)) runtimeFiles.add(new URL(url).pathname.split('/').at(-1) ?? '');
		if (!url.startsWith('chrome-extension://') && url !== articleUrl) remoteRequests.push({ url, body: request.postData() });
	});
	await context.route('https://huggingface.co/**', (route) => route.abort());
	await context.route(articleUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="vi"><head><title>Bản tin tiếng Việt</title></head><body><main><article>
				<h1>Bản tin tiếng Việt</h1>
				<p>ĐH mở đăng ký ngày 11/07/2026 với học phí 700.000đ. Thông báo nêu rõ chương trình dành cho người học trên toàn quốc và hồ sơ được tiếp nhận trực tuyến.</p>
				<p>Tỷ lệ hoàn thành đạt 12,5% trong đợt đầu. Nhà trường cho biết hệ thống sẽ tiếp tục mở trong nhiều tuần để thí sinh kiểm tra thông tin và bổ sung giấy tờ còn thiếu.</p>
				<p>Ban tuyển sinh khuyến nghị người học đọc kỹ hướng dẫn, giữ lại mã hồ sơ và liên hệ bộ phận hỗ trợ khi cần điều chỉnh dữ liệu đã khai báo.</p>
			</article></main></body></html>`,
		}),
	);

	const articlePage = await context.newPage();
	await articlePage.goto(articleUrl);
	const extensionPage = await context.newPage();
	await extensionPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await articlePage.bringToFront();

	const extracted = (await extensionPage.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		return chrome.tabs.sendMessage(tab.id!, { action: 'EXTRACT_ARTICLE' });
	})) as { success: boolean; article: { content: string; lang: string } };
	expect(extracted.success).toBe(true);
	expect(extracted.article.lang).toBe('vi');
	expect(extracted.article.content).toContain('ĐH mở đăng ký');
	expect(extracted.article.content).toContain('Tỷ lệ hoàn thành');

	const startedAt = Date.now();
	const started = (await extensionPage.evaluate(
		() => new Promise((resolve) => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE' }, resolve)),
	)) as { success: boolean };
	expect(started.success).toBe(true);
	expect(Date.now() - startedAt).toBeLessThan(2_000);

	const stopped = (await extensionPage.evaluate(
		() => new Promise((resolve) => chrome.runtime.sendMessage({ action: 'STOP_READING' }, resolve)),
	)) as { success: boolean };
	expect(stopped.success).toBe(true);

	const articleFragments = ['ĐH mở đăng ký', 'Tỷ lệ hoàn thành'];
	for (const request of remoteRequests) {
		expect(articleFragments.some((fragment) => request.body?.includes(fragment))).toBe(false);
	}
	const allowedRuntime = new Set(['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']);
	for (const file of runtimeFiles) expect(allowedRuntime.has(file) || /^ort\.webgpu\.min\.[a-f0-9]+\.mjs$/u.test(file)).toBe(true);
});
