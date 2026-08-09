import { planLatinSpeechUnits } from '../../src/offscreen/latin/speech_units.ts';
import { preparePlaybackUnits } from '../../src/offscreen/playback_preparation.ts';
import { normalizeSourceText } from '../../src/offscreen/text_normalization.ts';
import { expect, test } from './fixtures.ts';

function plan(source: string) {
	return planLatinSpeechUnits(normalizeSourceText(source).paragraphs);
}

function finalRendering(unit: { text: string; synthesisText?: string }): string {
	return unit.synthesisText ?? unit.text;
}

test.describe('Universal Text Segmentation E2E', () => {
	const vnexpressArticleText = `Đề cập thông tin do truyền thông Israel đăng tải rằng Ngoại trưởng Abbas Araghchi đã đồng ý với thỏa thuận do Mỹ và Qatar làm trung gian nhằm phân chia quyền kiểm soát eo biển Hormuz, hãng thông tấn Fars News thân cận với Vệ binh Cách mạng Hồi giáo Iran (IRGC) dẫn lời thành viên đoàn đàm phán nói rằng đó là điều "hoàn toàn sai sự thật".\n\nFars cũng dẫn lời một nguồn tin quân sự Iran khẳng định tuyến hàng hải chiến lược này vẫn đóng cửa đối với mọi tàu thuyền không phối hợp với IRGC.\n\nHuyền Lê (Theo AFP, CNN)`;

	test('plans complete sentences for VnExpress article without mid-sentence word splits', async () => {
		const planned = plan(vnexpressArticleText);
		expect(planned.length).toBeGreaterThan(0);

		// Assert no unit ends mid-sentence at arbitrary whitespace (e.g. "nguồn tin")
		for (const unit of planned) {
			expect(unit.text.endsWith('nguồn tin')).toBe(false);
			expect(unit.text.length).toBeLessThanOrEqual(300);
		}
	});

	test('fuses short citation tail into preceding paragraph in preparePlaybackUnits', async () => {
		const prepared = await preparePlaybackUnits(vnexpressArticleText, 'vi', null);
		expect(prepared.length).toBeGreaterThan(0);

		// Verify "Huyền Lê (Theo AFP, CNN)" is merged with preceding text instead of isolated
		const lastUnit = prepared.at(-1)!;
		expect(lastUnit.text).toContain('Huyền Lê (Theo AFP, CNN)');
		expect(lastUnit.text.length).toBeGreaterThan(50);
		expect(prepared.every((u) => u.text.length <= 300)).toBe(true);
	});

	test('keeps every reported phrase from article 5103660 intact after Vietnamese preparation', async () => {
		const source = `Lãnh đạo chủ chốt Đảng và Nhà nước tại hội nghị Trung ương 3 khóa 14, tháng 7/2026: Tổng Bí thư, Chủ tịch nước Tô Lâm.

Bộ Tài chính đề xuất sửa quy định về tiêu chuẩn, định mức sử dụng ôtô phục vụ lãnh đạo Đảng, Nhà nước.

Dự thảo sửa đổi nhiều quy định về chế độ sử dụng xe công đối với các chức danh lãnh đạo Đảng, Nhà nước.

Đề xuất được xây dựng trên cơ sở quy định của Bộ Chính trị ban hành tháng 9/2025.

Riêng Phó chủ nhiệm Ủy ban Kiểm tra Trung ương không là Ủy viên Trung ương Đảng được đề xuất sử dụng thường xuyên một ôtô trong thời gian công tác với mức giá tối đa 1,6 tỷ đồng.

Vũ Tuân`;
		const normalized = `Lãnh đạo chủ chốt Đảng và Nhà nước tại hội nghị Trung ương ba khóa mười bốn, tháng bảy năm hai nghìn không trăm hai mươi sáu: Tổng Bí thư, Chủ tịch nước Tô Lâm.

Bộ Tài chính đề xuất sửa quy định về tiêu chuẩn, định mức sử dụng ôtô phục vụ lãnh đạo Đảng, Nhà nước.

Dự thảo sửa đổi nhiều quy định về chế độ sử dụng xe công đối với các chức danh lãnh đạo Đảng, Nhà nước.

Đề xuất được xây dựng trên cơ sở quy định của Bộ Chính trị ban hành tháng chín năm hai nghìn không trăm hai mươi lăm.

Riêng Phó chủ nhiệm Ủy ban Kiểm tra Trung ương không là Ủy viên Trung ương Đảng được đề xuất sử dụng thường xuyên một ôtô trong thời gian công tác với mức giá tối đa một phẩy sáu tỷ đồng.

Vũ Tuân`;
		const prepared = await preparePlaybackUnits(source, 'vi', {
			normalize: async () => ({
				text: normalized,
				wordMap: [],
				diagnostics: { tokenCount: 0, crfMs: 0, expansionMs: 0, totalMs: 0, usedCrf: true, usedAbbreviationScorer: false },
			}),
		});
		const rendering = prepared.map(finalRendering).join(' ');

		expect(rendering).toContain('tháng bảy năm hai nghìn không trăm hai mươi sáu');
		expect(rendering).toContain('phục vụ lãnh đạo Đảng');
		expect(rendering).toContain('xe công đối với các chức danh');
		expect(rendering).toContain('tháng chín năm hai nghìn không trăm hai mươi lăm');
		expect(rendering).toContain('mức giá tối đa một phẩy sáu tỷ đồng. Vũ Tuân');
		expect(rendering).not.toContain('tháng tháng');
		expect(rendering).not.toContain('đối đối');
	});

	// Article, Selected Text, PDF, and Playlist Item all reach synthesis through the single
	// preparePlaybackUnits() call in offscreen.ts, so source origin cannot select a segmentation
	// policy. What is asserted here is that contract: the same raw text and resolved language
	// produce the same units no matter which source produced them. Driving all four extraction
	// paths through the browser is covered by their own specs.
	test('prepares source-neutral, deterministic units for identical text and language', async () => {
		const sources = ['article', 'selection', 'pdf', 'playlist'];
		const runs = await Promise.all(sources.map(() => preparePlaybackUnits(vnexpressArticleText, 'vi', null)));

		for (const run of runs.slice(1)) {
			expect(JSON.stringify(run)).toBe(JSON.stringify(runs[0]));
		}
		// R10.1: repeated preparation of the same input is byte-for-byte stable.
		expect(JSON.stringify(await preparePlaybackUnits(vnexpressArticleText, 'vi', null))).toBe(JSON.stringify(runs[0]));
	});

	test('keeps every Final Rendering within the resolved capacity for Latin, Vietnamese, Korean, and Japanese', async () => {
		const cases: Array<{ language: string; limit: number; source: string }> = [
			{ language: 'vi', limit: 300, source: vnexpressArticleText },
			{ language: 'en', limit: 300, source: 'A first sentence here. A second one follows.\n\n'.repeat(12) },
			{ language: 'ko', limit: 120, source: '짧은 문장입니다. 다음 문장도 짧습니다.\n\n'.repeat(8) },
			{ language: 'ja', limit: 120, source: '短い文です。次の文も短いです。\n\n'.repeat(8) },
		];

		for (const { language, limit, source } of cases) {
			const prepared = await preparePlaybackUnits(source, language, null);
			expect(prepared.length).toBeGreaterThan(0);
			for (const unit of prepared) {
				expect(finalRendering(unit).length, `${language}: ${JSON.stringify(unit.text)}`).toBeLessThanOrEqual(limit);
				expect(unit.text.trim().length).toBeGreaterThan(0);
			}
		}
	});
});
