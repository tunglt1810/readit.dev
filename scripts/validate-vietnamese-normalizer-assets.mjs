import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_COMMIT = 'c2b0c1eb36cec1584416ca4652b5391f4e723727';
const MAX_ASSET_BYTES = 5_242_880;
const EXPECTED_LABELS = [
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
const ALLOWED_ORT_FILES = new Set(['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']);
const ALLOWED_BUNDLED_ORT_FRONTEND = /^static\/assets\/ort\.webgpu\.min\.[a-f0-9]+\.mjs$/u;

function assertRecord(value, name) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${name} must be an object`);
	}
	return value;
}

function assertLicense(value, name) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${name} must declare an explicit license`);
	}
}

function safeAssetPath(rootDir, assetPath) {
	if (typeof assetPath !== 'string' || assetPath.length === 0 || isAbsolute(assetPath)) {
		throw new Error(`Invalid asset path: ${String(assetPath)}`);
	}

	const normalizedPath = normalize(assetPath);
	if (normalizedPath === '..' || normalizedPath.startsWith(`..${sep}`)) {
		throw new Error(`Asset path escapes root: ${assetPath}`);
	}

	const absolutePath = join(rootDir, normalizedPath);
	const relativePath = relative(rootDir, absolutePath);
	if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
		throw new Error(`Asset path escapes root: ${assetPath}`);
	}
	return absolutePath;
}

function validateLabels(labels) {
	if (!Array.isArray(labels) || labels.length !== EXPECTED_LABELS.length) {
		throw new Error(`Expected exactly ${EXPECTED_LABELS.length} pinned checkpoint labels`);
	}
	if (new Set(labels).size !== labels.length) {
		throw new Error('CRF labels must be unique');
	}
	for (let index = 0; index < EXPECTED_LABELS.length; index++) {
		if (labels[index] !== EXPECTED_LABELS[index]) {
			throw new Error(`Unexpected CRF label at index ${index}: ${String(labels[index])}`);
		}
	}
}

async function listOrtRuntimeFiles(distDir) {
	const files = [];
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
			} else if (entry.isFile() && (entry.name.endsWith('.wasm') || entry.name.endsWith('.mjs'))) {
				files.push(relative(distDir, path).split(sep).join('/'));
			}
		}
	}
	await visit(distDir);
	return files.sort();
}

export async function validateVietnameseNormalizerAssets(rootDir, options = {}) {
	const manifestPath = join(rootDir, 'model-manifest.json');
	const manifest = assertRecord(JSON.parse(await readFile(manifestPath, 'utf8')), 'model manifest');

	if (manifest.formatVersion !== 1) {
		throw new Error(`Unsupported model manifest version: ${String(manifest.formatVersion)}`);
	}

	const source = assertRecord(manifest.source, 'source');
	if (source.commit !== SOURCE_COMMIT) {
		throw new Error(`Expected pinned source commit ${SOURCE_COMMIT}`);
	}
	assertLicense(source.license, 'source');

	const modelSource = assertRecord(manifest.modelSource, 'modelSource');
	if (typeof modelSource.revision !== 'string' || !/^[a-f0-9]{40}$/.test(modelSource.revision)) {
		throw new Error('modelSource must use a full 40-character model revision');
	}
	assertLicense(modelSource.license, 'modelSource');

	if (!Number.isSafeInteger(manifest.assetBudgetBytes) || manifest.assetBudgetBytes <= 0) {
		throw new Error('assetBudgetBytes must be a positive integer');
	}
	const budgetBytes = Math.min(manifest.assetBudgetBytes, MAX_ASSET_BYTES);
	if (!Array.isArray(manifest.files)) {
		throw new Error('manifest files must be an array');
	}

	let totalBytes = 0;
	const paths = new Set();
	for (const rawFile of manifest.files) {
		const file = assertRecord(rawFile, 'asset file');
		if (typeof file.path !== 'string' || paths.has(file.path)) {
			throw new Error(`Duplicate or invalid asset path: ${String(file.path)}`);
		}
		paths.add(file.path);
		assertLicense(file.license, `asset ${file.path}`);
		if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
			throw new Error(`Invalid checksum/size metadata for ${file.path}`);
		}

		const filePath = safeAssetPath(rootDir, file.path);
		const data = await readFile(filePath);
		const actualSize = (await stat(filePath)).size;
		const actualSha256 = createHash('sha256').update(data).digest('hex');
		if (actualSize !== file.bytes || actualSha256 !== file.sha256) {
			throw new Error(`Asset checksum/size mismatch for ${file.path}`);
		}
		totalBytes += actualSize;
	}

	if (totalBytes > budgetBytes) {
		throw new Error(`Vietnamese normalizer asset budget exceeded: ${totalBytes} > ${budgetBytes}`);
	}
	validateLabels(manifest.labels);

	if (options.release) {
		for (const [name, value] of [
			['confidenceThreshold', manifest.abbreviation?.confidenceThreshold],
			['confidenceMargin', manifest.abbreviation?.confidenceMargin],
		]) {
			if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
				throw new Error(`${name} must be a finite value between 0 and 1`);
			}
		}
	}

	if (typeof options.distDir === 'string') {
		const distAssetRoot = join(options.distDir, 'assets', 'vietnamese-normalizer');
		await stat(join(options.distDir, 'THIRD_PARTY_NOTICES.txt'));
		for (const file of manifest.files) {
			const sourceData = await readFile(safeAssetPath(rootDir, file.path));
			const distData = await readFile(safeAssetPath(distAssetRoot, file.path));
			if (!sourceData.equals(distData)) {
				throw new Error(`Built asset differs from source: ${file.path}`);
			}
		}
	}

	let wasmFiles = [];
	if (options.checkWasm) {
		if (typeof options.distDir !== 'string') {
			throw new Error('--check-wasm requires --dist');
		}
		wasmFiles = await listOrtRuntimeFiles(options.distDir);
		const unexpected = wasmFiles.filter((file) => !ALLOWED_ORT_FILES.has(file) && !ALLOWED_BUNDLED_ORT_FRONTEND.test(file));
		if (unexpected.length > 0) {
			throw new Error(`Unexpected ONNX Runtime files: ${unexpected.join(', ')}`);
		}
		for (const expected of ALLOWED_ORT_FILES) {
			if (!wasmFiles.includes(expected)) {
				throw new Error(`Missing ONNX Runtime file: ${expected}`);
			}
		}
	}

	return {
		totalBytes,
		fileCount: manifest.files.length,
		modelRevision: modelSource.revision,
		wasmFiles,
	};
}

function parseCliArgs(args) {
	const options = {};
	let rootDir;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--release') {
			options.release = true;
		} else if (arg === '--check-wasm') {
			options.checkWasm = true;
		} else if (arg === '--dist') {
			options.distDir = args[++index];
		} else if (!rootDir) {
			rootDir = arg;
		} else {
			throw new Error(`Unexpected argument: ${arg}`);
		}
	}
	if (!rootDir) {
		throw new Error('Usage: validate-vietnamese-normalizer-assets.mjs <asset-root> [--release] [--dist <dir>] [--check-wasm]');
	}
	return { rootDir, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const { rootDir, options } = parseCliArgs(process.argv.slice(2));
		const report = await validateVietnameseNormalizerAssets(rootDir, options);
		process.stdout.write(`${JSON.stringify(report)}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
