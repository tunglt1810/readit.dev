import { expect, test } from './fixtures';

test.describe('Kịch bản 2: Trích xuất nội dung (Reader Mode)', () => {
	async function requestArticle(extPage: import('@playwright/test').Page) {
		return extPage.evaluate(async () => {
			const [targetTab] = await chrome.tabs.query({ active: true, currentWindow: true });
			if (!targetTab?.id) {
				return { success: false, error: 'Không tìm thấy tab mục tiêu' };
			}

			return new Promise((resolve) => {
				chrome.tabs.sendMessage(targetTab.id, { action: 'EXTRACT_ARTICLE' }, (res) => {
					resolve(res);
				});
			});
		});
	}

	test('Trích xuất tiêu đề và nội dung chính của trang bài viết mockup', async ({ context, page, extensionId }) => {
		// 1. Tạo một trang web mockup chứa nội dung bài viết có nhiều ads/sidebar để kiểm tra tính năng lọc nhiễu
		await context.route('https://example.com/', async (route) => {
			await route.fulfill({
				contentType: 'text/html; charset=utf-8',
				body: `
					<html>
						<head>
							<title>Cách viết code sạch với TypeScript 6</title>
						</head>
						<body>
							<nav>
								<ul>
									<li><a href="/">Trang chủ</a></li>
									<li><a href="/news">Tin tức</a></li>
								</ul>
							</nav>
							<aside class="sidebar">
								<h3>Quảng cáo cực hot!</h3>
								<p>Mua ngay kẻo lỡ sản phẩm siêu cấp vip pro.</p>
							</aside>
							<main>
								<article>
									<h1 id="main-title">Cách viết code sạch với TypeScript 6</h1>
									<div class="meta">Đăng bởi: Antigravity vào 2026</div>
									<p>Đây là đoạn văn đầu tiên chứa nội dung quan trọng của bài viết. Chúng ta cần đảm bảo đoạn này được trích xuất chính xác.</p>
									<p>Đoạn văn thứ hai tiếp tục thảo luận về các mẫu thiết kế và cách tối ưu hóa hiệu năng ứng dụng.</p>
								</article>
							</main>
							<footer>
								<p>© 2026 Bản quyền thuộc về TechNews</p>
							</footer>
						</body>
					</html>
				`,
			});
		});
		const mockPage = await context.newPage();
		await mockPage.goto('https://example.com/');

		// 2. Mở một trang trống thuộc Extension để có quyền gọi API chrome.runtime
		const extPage = await context.newPage();
		await extPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		await mockPage.bringToFront();

		// 3. Gửi tin nhắn EXTRACT_ARTICLE tới tab chứa bài viết mockup để lấy bài viết đã trích xuất
		const result = await extPage.evaluate(async () => {
			const [targetTab] = await chrome.tabs.query({ active: true, currentWindow: true });
			if (!targetTab?.id) {
				return { success: false, error: 'Không tìm thấy tab mục tiêu' };
			}

			// Gửi message yêu cầu trích xuất nội dung
			return new Promise((resolve) => {
				chrome.tabs.sendMessage(targetTab.id, { action: 'EXTRACT_ARTICLE' }, (res) => {
					resolve(res);
				});
			});
		});

		// 4. Kiểm tra kết quả trích xuất
		const articleResult = result as { success: boolean; article?: { title: string; content: string; lang: string } };
		expect(articleResult.success).toBe(true);
		expect(articleResult.article).toBeDefined();

		const article = articleResult.article!;

		// Tiêu đề phải được lấy từ thẻ h1 của article
		expect(article.title).toBe('Cách viết code sạch với TypeScript 6');

		// Nội dung chính không được chứa nội dung quảng cáo từ aside/nav/footer
		expect(article.content).toContain('Đây là đoạn văn đầu tiên chứa nội dung quan trọng của bài viết.');
		expect(article.content).toContain('Đoạn văn thứ hai tiếp tục thảo luận về các mẫu thiết kế');
		expect(article.content).not.toContain('Quảng cáo cực hot!');
		expect(article.content).not.toContain('Trang chủ');
		expect(article.content).not.toContain('Bản quyền thuộc về TechNews');
	});

	test('Loại related content và UI controls nằm trong cùng article wrapper', async ({ context, extensionId }) => {
		await context.route('https://example.com/article-with-noise', async (route) => {
			await route.fulfill({
				contentType: 'text/html; charset=utf-8',
				body: `
					<html lang="vi">
						<head><title>Câu chuyện cứu hộ trên biển</title></head>
						<body>
							<div class="site-shell">
								<nav class="main-navigation">
									<a href="/">Trang chủ</a>
									<a href="/latest">Tin mới nhất</a>
									<a href="/world">Thế giới</a>
								</nav>
								<div class="mobile-menu" aria-hidden="true">Menu mobile không được đọc</div>
								<main>
									<article id="article-root">
										<h1>Câu chuyện cứu hộ trên biển</h1>
										<p>Đội cứu hộ đã tiếp cận con tàu giữa thời tiết xấu để đưa hành khách vào bờ an toàn.</p>
										<p>
											Những người có mặt tại hiện trường phối hợp liên tục trong nhiều giờ và hoàn thành
											việc cứu nạn.
										</p>
										<div class="media-control"><button>Play video</button><span>Bấm để lật ảnh</span></div>
										<span id="article-end"></span>
										<div class="box-tinlienquanv2">
											<h2>Bài liên quan không thuộc nội dung chính</h2>
											<p>Đây là phần gợi ý bài viết khác và không được phép đưa vào TTS.</p>
										</div>
									</article>
								</main>
							</div>
						</body>
					</html>
				`,
			});
		});

		const page = await context.newPage();
		await page.goto('https://example.com/article-with-noise');
		const extPage = await context.newPage();
		await extPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		await page.bringToFront();

		const result = (await requestArticle(extPage)) as {
			success: boolean;
			article?: { title: string; content: string };
		};

		expect(result.success).toBe(true);
		expect(result.article?.title).toBe('Câu chuyện cứu hộ trên biển');
		expect(result.article?.content).toContain('Đội cứu hộ đã tiếp cận con tàu');
		expect(result.article?.content).not.toContain('Trang chủ');
		expect(result.article?.content).not.toContain('Bấm để lật ảnh');
		expect(result.article?.content).not.toContain('Bài liên quan không thuộc nội dung chính');
	});

	test('Chèn khoảng trắng giữa text của span liền kề và text tiếp theo khi không có khoảng trắng thật trong DOM', async ({
		context,
		extensionId,
	}) => {
		// Tái hiện đúng cấu trúc DOM thật của vnexpress.net: badge địa danh (<span>) nằm ngay đầu
		// đoạn văn, không có text node khoảng trắng nào phân cách nó với phần text tiếp theo — dấu
		// "-" người dùng nhìn thấy chỉ là hiệu ứng CSS (border/background), không phải ký tự thật.
		// element.textContent (và cả innerText) ghép hai đoạn này dính liền thành "GiangThấy", khiến
		// TTS phát âm sai và làm hỏng việc tìm-từ để highlight (không có "GiangThấy" nào tồn tại
		// trong DOM để khớp).
		await context.route('https://example.com/adjacent-span', async (route) => {
			await route.fulfill({
				contentType: 'text/html; charset=utf-8',
				body: `
					<html lang="vi">
						<head><title>Nỗ lực cứu du khách lật canô ở Phú Quốc</title></head>
						<body>
							<main>
								<article>
									<h1 id="main-title">Nỗ lực cứu du khách lật canô ở Phú Quốc</h1>
									<p id="content"><span class="location-stamp">An Giang</span>Thấy nhiều du khách Ấn Độ bám trên thân canô lật úp, số khác trôi trên biển Phú Quốc, anh Hà Văn Lộc cố lái tàu tiếp cận giữa sóng lớn.</p>
								</article>
							</main>
						</body>
					</html>
				`,
			});
		});

		const page = await context.newPage();
		await page.goto('https://example.com/adjacent-span');
		const extPage = await context.newPage();
		await extPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		await page.bringToFront();

		const result = (await requestArticle(extPage)) as { success: boolean; article?: { content: string } };

		expect(result.success).toBe(true);
		expect(result.article?.content).toContain('An Giang Thấy nhiều du khách');
		expect(result.article?.content).not.toContain('GiangThấy');
	});

	test('Từ chối trang chỉ chứa navigation thay vì đọc raw body', async ({ context, extensionId }) => {
		await context.route('https://example.com/navigation-only', async (route) => {
			await route.fulfill({
				contentType: 'text/html; charset=utf-8',
				body: `
					<html>
						<head><title>Trang danh mục</title></head>
						<body>
							<nav>
								<a href="/">Trang chủ</a>
								<a href="/news">Tin tức</a>
								<a href="/sports">Thể thao</a>
							</nav>
							<div class="menu-list">Danh sách menu điều hướng không phải bài viết.</div>
						</body>
					</html>
				`,
			});
		});

		const page = await context.newPage();
		await page.goto('https://example.com/navigation-only');
		const extPage = await context.newPage();
		await extPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		await page.bringToFront();

		const result = (await requestArticle(extPage)) as { success: boolean; error?: string; article?: unknown };

		expect(result.success).toBe(false);
		expect(result.article).toBeUndefined();
		expect(result.error).toContain('Could not find a readable article');
	});
});
