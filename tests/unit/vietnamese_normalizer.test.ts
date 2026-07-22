import assert from 'node:assert/strict';
import test from 'node:test';
import { detectVietnameseLabels, normalizeVietnameseText } from '../../src/offscreen/vietnamese/normalizer.ts';
import { tokenizeVietnameseText } from '../../src/offscreen/vietnamese/tokenizer.ts';
import type { NormalizationDependencies } from '../../src/offscreen/vietnamese/types.ts';

function createTestNormalizationDependencies(): NormalizationDependencies {
	let clock = 0;
	return {
		assets: {
			detector: {
				detect: (tokens) => tokens.map((token) => (token.text === 'ĐH' ? 'B-LABB' : 'O')),
			},
			vietnameseSyllables: new Set(['mở', 'đăng', 'ký', 'ngày', 'học', 'phí', 'tỷ', 'lệ', 'đạt']),
			abbreviations: new Map([['ĐH', ['đại học']]]),
			abbreviationScorer: null,
			confidenceThreshold: 0.54,
			confidenceMargin: 0.08,
		},
		now: () => ++clock,
	};
}

test('normalizes required Vietnamese cases and is idempotent', async () => {
	const source = 'ĐH mở đăng ký ngày 11/07/2026, học phí 700.000đ.\n\nTỷ lệ đạt 12,5%.';
	const dependencies = createTestNormalizationDependencies();
	const first = await normalizeVietnameseText(source, dependencies);
	const second = await normalizeVietnameseText(first.text, dependencies);
	assert.equal(
		first.text,
		'đại học mở đăng ký ngày mười một tháng bảy năm hai nghìn không trăm hai mươi sáu, học phí bảy trăm nghìn đồng.\n\nTỷ lệ đạt mười hai phẩy năm phần trăm.',
	);
	assert.equal(second.text, first.text);
	assert.equal(first.diagnostics.usedCrf, true);
});

test('keeps hour-only normalization idempotent across two passes', async () => {
	const dependencies = createTestNormalizationDependencies();
	const first = await normalizeVietnameseText('Lúc 10h.', dependencies);
	const second = await normalizeVietnameseText(first.text, dependencies);
	assert.equal(first.text, 'Lúc mười giờ.');
	assert.equal(second.text, 'Lúc mười giờ.');
});

test('lets strict money override CRF LSEQ and preserves rejected money shapes', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.detector = {
		detect(tokens) {
			return tokens.map((token) => (token.text.endsWith('USD') ? 'B-LSEQ' : 'O'));
		},
	};
	const source = 'Chi phí 1.000 USD. Mã 1.00 USD.';
	const first = await normalizeVietnameseText(source, dependencies);
	const second = await normalizeVietnameseText(first.text, dependencies);
	assert.equal(first.text, 'Chi phí một nghìn đô la. Mã 1.00 USD.');
	assert.equal(second.text, first.text);
});

test('protects Roman-shaped Vietnamese syllables even when CRF labels them ROMA', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.vietnameseSyllables = new Set([...dependencies.assets.vietnameseSyllables, 'di']);
	dependencies.assets.detector = {
		detect(tokens) {
			return tokens.map((token) => (/^(?:di|xiv)$/iu.test(token.text) ? 'B-ROMA' : 'O'));
		},
	};
	const source = 'thiết bị di động. DI CHUYỂN. Mục XIV.';
	const first = await normalizeVietnameseText(source, dependencies);
	const second = await normalizeVietnameseText(first.text, dependencies);
	assert.equal(first.text, 'thiết bị di động. DI CHUYỂN. Mục mười bốn.');
	assert.equal(second.text, first.text);
});

test('uses explicit context for Roman numerals when CRF is unavailable', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.vietnameseSyllables = new Set([...dependencies.assets.vietnameseSyllables, 'di']);
	dependencies.assets.detector = null;
	assert.equal((await normalizeVietnameseText('IV. Phạm vi.', dependencies)).text, 'bốn. Phạm vi.');
	assert.equal(
		(await normalizeVietnameseText('Mục DI. Chương IV. thế kỷ XXI. IV. Phạm vi.', dependencies)).text,
		'Mục năm trăm linh một. Chương bốn. thế kỷ hai mươi mốt. bốn. Phạm vi.',
	);
});

test('does not infer Roman context across punctuation or inline punctuation boundaries', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.vietnameseSyllables = new Set([...dependencies.assets.vietnameseSyllables, 'vi']);
	dependencies.assets.detector = null;
	for (const source of ['Kết thúc thế kỷ. VI tiếp tục.', 'Nhãn “VI.” vẫn giữ nguyên.', 'A, VI. tiếp tục.']) {
		assert.equal((await normalizeVietnameseText(source, dependencies)).text, source);
	}
});

test('falls back to deterministic spans when the CRF is unavailable', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.detector = null;
	const result = await normalizeVietnameseText('Ngày 29/02/2024 đạt 7,9%.', dependencies);
	assert.equal(result.text, 'Ngày hai mươi chín tháng hai năm hai nghìn không trăm hai mươi tư đạt bảy phẩy chín phần trăm.');
	assert.equal(result.diagnostics.usedCrf, false);
});

test('restores exact source spans for malformed labels and expansion failures', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.detector = { detect: () => ['B-LABB'] };
	assert.equal((await normalizeVietnameseText('ĐH mở đăng ký.', dependencies)).text, 'ĐH mở đăng ký.');

	dependencies.assets.detector = { detect: (tokens) => tokens.map(() => 'B-USS') };
	assert.equal((await normalizeVietnameseText('tàu USS Ford.', dependencies)).text, 'tàu USS Ford.');
});

test('preserves punctuation, paragraphs, and adjacent original spelling', async () => {
	const dependencies = createTestNormalizationDependencies();
	const source = 'Mở—ĐH; mã AB-123-CD.\n\nEmail dev-team@example.vn.';
	const result = await normalizeVietnameseText(source, dependencies);
	assert.equal(result.text, 'Mở—đại học; mã AB-123-CD.\n\nEmail đê e vê gạch ngang tê e a mờ a còng e ích a mờ pê lờ e chấm vê nờ.');
});

test('keeps article text in memory without fetch or storage dependencies', async () => {
	const dependencies = createTestNormalizationDependencies();
	assert.deepEqual(Object.keys(dependencies).sort(), ['assets', 'now']);
	const result = await normalizeVietnameseText('ĐH', dependencies);
	assert.equal(result.text, 'đại học');
	assert.equal(result.diagnostics.tokenCount, 1);
});

test('runs the CRF on the complete token sequence', async () => {
	const dependencies = createTestNormalizationDependencies();
	let calls = 0;
	let observedTokenCount = 0;
	dependencies.assets.vietnameseSyllables = new Set(['bản', 'tin', 'ngày']);
	dependencies.assets.detector = {
		detect(tokens) {
			calls++;
			observedTokenCount = tokens.length;
			return tokens.map(() => 'O');
		},
	};
	const source = Array.from({ length: 100 }, () => 'bản tin ngày 11/07/2026').join('. ');
	const result = await normalizeVietnameseText(source, dependencies);
	assert.equal(calls, 1);
	assert.equal(observedTokenCount, result.diagnostics.tokenCount);
	assert.ok(result.text.includes('mười một tháng bảy năm hai nghìn không trăm hai mươi sáu'));
});

test('keeps ambiguous fractions, scores, and ranges aligned with CRF/context', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.detector = {
		detect(tokens) {
			return tokens.map((token) => {
				if (token.text === '1/2') return 'B-NFRC';
				if (token.text === '2-1') return 'B-NSCR';
				return 'O';
			});
		},
	};
	assert.equal(
		(await normalizeVietnameseText('Ăn 1/2 chiếc bánh. Tỷ số 2-1.', dependencies)).text,
		'Ăn một trên hai chiếc bánh. Tỷ số hai một.',
	);

	dependencies.assets.detector = null;
	assert.equal(
		(await normalizeVietnameseText('Ngày 11/07. Tỷ lệ 1/2. Tỷ số 2-1. Khoảng 10-12 km.', dependencies)).text,
		'Ngày mười một tháng bảy. Tỷ lệ một trên hai. Tỷ số hai một. Khoảng mười đến mười hai ki lô mét.',
	);
});

test('does not overwrite a supported CRF label with a deterministic numeric guess', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.detector = {
		detect(tokens) {
			return tokens.map((token) => (token.text === '090' ? 'B-NDIG' : 'O'));
		},
	};
	assert.equal((await normalizeVietnameseText('Mã 090.', dependencies)).text, 'Mã không chín không.');
});

test('protects opaque identifiers and keeps an explicit version label deterministic', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.detector = {
		detect(tokens) {
			return tokens.map((token) => {
				if (token.text === 'AB-123-CD') return 'B-LSEQ';
				if (token.text === 'IPv4') return 'B-LWRD';
				if (token.text === '192.168.1.1') return 'B-NNUM';
				if (token.text === 'v1.2.3') return 'B-LSEQ';
				return 'O';
			});
		},
	};
	const source = 'Mã AB-123-CD, IPv4 192.168.1.1, bản v1.2.3.';
	assert.equal(
		(await normalizeVietnameseText(source, dependencies)).text,
		'Mã AB-123-CD, IPv4 192.168.1.1, bản vê một chấm hai chấm ba.',
	);
	const paragraph = tokenizeVietnameseText(source).paragraphs[0];
	const labels = detectVietnameseLabels(paragraph.tokens, dependencies.assets).labels;
	assert.equal(labels[paragraph.tokens.findIndex(({ text }) => text === 'v1.2.3')], 'B-NVER');
});

test('builds a word map that groups an expanded date span back to its original token', async () => {
	const dependencies = createTestNormalizationDependencies();
	const result = await normalizeVietnameseText('Có 11/07/2026.', dependencies);
	assert.equal(result.text, 'Có ngày mười một tháng bảy năm hai nghìn không trăm hai mươi sáu.');
	const dateEntry = result.wordMap.find((entry) => entry.originalText === '11/07/2026');
	assert.ok(dateEntry, 'expected a word map entry for the original date token');
	assert.equal(
		result.text.slice(dateEntry.spokenStart, dateEntry.spokenEnd),
		'ngày mười một tháng bảy năm hai nghìn không trăm hai mươi sáu',
	);
	const plainEntry = result.wordMap.find((entry) => entry.originalText === 'Có');
	assert.ok(plainEntry, 'expected a word map entry for the plain leading word');
	assert.equal(result.text.slice(plainEntry.spokenStart, plainEntry.spokenEnd), 'Có');
});

test('excludes punctuation tokens from the word map, keeping them in the spoken text only', async () => {
	// Punctuation tokens (",", ".") are always adjacent to a letter on at least one side (e.g.
	// "úp,"), so a comma's own natural position can never satisfy a word-boundary-aware DOM search.
	// If a comma is ever sent as a highlight target, the search is forced to skip ahead to some
	// unrelated, distant comma that happens to be boundary-satisfying (e.g. one preceded by a
	// closing quote) — silently eating every real word in between. Punctuation must never become a
	// wordMap/highlight target in the first place.
	const dependencies = createTestNormalizationDependencies();
	const result = await normalizeVietnameseText('Có, khác.', dependencies);
	assert.equal(result.text, 'Có, khác.');
	assert.equal(
		result.wordMap.find((entry) => entry.originalText === ','),
		undefined,
		'expected no word map entry for the comma punctuation token',
	);
	assert.equal(
		result.wordMap.find((entry) => entry.originalText === '.'),
		undefined,
		'expected no word map entry for the period punctuation token',
	);
	const plainEntry = result.wordMap.find((entry) => entry.originalText === 'khác');
	assert.ok(plainEntry, 'expected a word map entry for the plain word after the comma');
	assert.equal(result.text.slice(plainEntry.spokenStart, plainEntry.spokenEnd), 'khác');
});

test('keeps words separate when a detected abbreviation span is not expanded', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.detector = {
		detect(tokens) {
			return tokens.map((token, index) => {
				if (token.text === 'Channel') {
					return 'B-LABB';
				}
				return index > 2 && index <= 5 ? 'I-LABB' : 'O';
			});
		},
	};
	const source = '**Channel Activity Analysis (4.6.6):** Phân tích';
	const result = await normalizeVietnameseText(source, dependencies);

	assert.equal(result.text, '**Channel Activity Analysis (4.6.sáu):** Phân tích');
	assert.deepEqual(
		result.wordMap.slice(0, 3).map((entry) => entry.originalText),
		['Channel', 'Activity', 'Analysis'],
	);
});

test('accounts for the paragraph separator when computing word map offsets across paragraphs', async () => {
	const dependencies = createTestNormalizationDependencies();
	const result = await normalizeVietnameseText('Mở đầu.\n\nĐH kết thúc.', dependencies);
	const abbrevEntry = result.wordMap.find((entry) => entry.originalText === 'ĐH');
	assert.ok(abbrevEntry, 'expected a word map entry for the abbreviation in the second paragraph');
	assert.equal(result.text.slice(abbrevEntry.spokenStart, abbrevEntry.spokenEnd), 'đại học');
});
