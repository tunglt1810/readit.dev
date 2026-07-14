import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { validateVietnameseNormalizerAssets } from '../../scripts/validate-vietnamese-normalizer-assets.mjs';

const CHECKPOINT_LABELS = [
	'O',
	'B-LWRD',
	'I-LWRD',
	'B-NSCR',
	'B-NNUM',
	'B-URLE',
	'B-NDAY',
	'B-LABB',
	'B-LSEQ',
	'B-MEA',
	'B-NFRC',
	'I-LSEQ',
	'I-LABB',
	'B-NDAT',
	'B-NRNG',
	'B-ROMA',
	'B-NDIG',
	'I-NSCR',
	'B-NMON',
	'B-NPER',
	'I-NDIG',
	'B-NTIM',
	'B-MONEY',
	'B-NVER',
	'B-USS',
	'I-MEA',
	'I-NTIM',
	'I-MONEY',
	'B-NQUA',
	'I-NRNG',
];

function scratchDir(): string {
	mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
	return mkdtempSync(join(process.cwd(), '.tmp', 'vi-assets-test-'));
}

test('rejects a manifest with a non-immutable model revision', async (t) => {
	const root = scratchDir();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(
		join(root, 'model-manifest.json'),
		JSON.stringify({
			formatVersion: 1,
			source: { commit: 'c2b0c1eb36cec1584416ca4652b5391f4e723727', license: 'MIT' },
			modelSource: { revision: 'cb9705b', license: 'MIT' },
			assetBudgetBytes: 5_242_880,
			labels: [],
			files: [],
		}),
	);

	await assert.rejects(() => validateVietnameseNormalizerAssets(root), /full 40-character model revision/);
});

test('rejects a checksum mismatch and an over-budget asset set', async (t) => {
	const root = scratchDir();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, 'abbreviations.txt'), 'ĐH:đại học\n');
	writeFileSync(
		join(root, 'model-manifest.json'),
		JSON.stringify({
			formatVersion: 1,
			source: { commit: 'c2b0c1eb36cec1584416ca4652b5391f4e723727', license: 'MIT' },
			modelSource: { revision: '1234567890123456789012345678901234567890', license: 'MIT' },
			assetBudgetBytes: 1,
			labels: [],
			files: [{ path: 'abbreviations.txt', bytes: 14, sha256: '0'.repeat(64), license: 'MIT' }],
		}),
	);

	await assert.rejects(() => validateVietnameseNormalizerAssets(root), /checksum|budget/i);
});

test('accepts the immutable checkpoint label order and valid asset metadata', async (t) => {
	const root = scratchDir();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const data = Buffer.from('ĐH:đại học\n');
	writeFileSync(join(root, 'abbreviations.txt'), data);
	writeFileSync(
		join(root, 'model-manifest.json'),
		JSON.stringify({
			formatVersion: 1,
			source: { commit: 'c2b0c1eb36cec1584416ca4652b5391f4e723727', license: 'MIT' },
			modelSource: { revision: 'cb9705bd465a4e60d75c2e267dd1f846cd0ad9cb', license: 'MIT' },
			assetBudgetBytes: 5_242_880,
			labels: CHECKPOINT_LABELS,
			files: [
				{
					path: 'abbreviations.txt',
					bytes: data.byteLength,
					sha256: createHash('sha256').update(data).digest('hex'),
					license: 'MIT',
				},
			],
		}),
	);

	assert.deepEqual(await validateVietnameseNormalizerAssets(root), {
		totalBytes: data.byteLength,
		fileCount: 1,
		modelRevision: 'cb9705bd465a4e60d75c2e267dd1f846cd0ad9cb',
		wasmFiles: [],
	});
});

test('rejects unlisted ONNX Runtime artifacts in nested build directories', async (t) => {
	const root = scratchDir();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dist = join(root, 'dist');
	const distAssets = join(dist, 'assets', 'vietnamese-normalizer');
	mkdirSync(distAssets, { recursive: true });
	mkdirSync(join(dist, 'static', 'wasm'), { recursive: true });
	const data = Buffer.from('ĐH:đại học\n');
	writeFileSync(join(root, 'abbreviations.txt'), data);
	writeFileSync(join(distAssets, 'abbreviations.txt'), data);
	writeFileSync(join(dist, 'THIRD_PARTY_NOTICES.txt'), 'notices');
	writeFileSync(join(dist, 'ort-wasm-simd-threaded.asyncify.mjs'), 'loader');
	writeFileSync(join(dist, 'ort-wasm-simd-threaded.asyncify.wasm'), 'wasm');
	writeFileSync(join(dist, 'static', 'wasm', 'unexpected.asyncify.wasm'), 'unexpected');
	writeFileSync(
		join(root, 'model-manifest.json'),
		JSON.stringify({
			formatVersion: 1,
			source: { commit: 'c2b0c1eb36cec1584416ca4652b5391f4e723727', license: 'MIT' },
			modelSource: { revision: 'cb9705bd465a4e60d75c2e267dd1f846cd0ad9cb', license: 'MIT' },
			assetBudgetBytes: 5_242_880,
			labels: CHECKPOINT_LABELS,
			files: [
				{
					path: 'abbreviations.txt',
					bytes: data.byteLength,
					sha256: createHash('sha256').update(data).digest('hex'),
					license: 'MIT',
				},
			],
		}),
	);

	await assert.rejects(() => validateVietnameseNormalizerAssets(root, { distDir: dist, checkWasm: true }), /unexpected.*asyncify/i);
});
