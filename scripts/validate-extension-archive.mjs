import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const archive = process.argv[2];
if (!archive) {
	throw new Error('Usage: validate-extension-archive.mjs <extension.zip>');
}
const files = new Set(execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split(/\r?\n/u).filter(Boolean));
const readArchivedFile = (path) => execFileSync('unzip', ['-p', archive, path], { maxBuffer: 32 * 1024 * 1024 });
const modelManifestPath = 'assets/vietnamese-normalizer/model-manifest.json';
const sourceModelManifest = readFileSync('public/assets/vietnamese-normalizer/model-manifest.json');
const archivedModelManifest = readArchivedFile(modelManifestPath);
if (!archivedModelManifest.equals(sourceModelManifest)) {
	throw new Error('Archived Vietnamese model manifest differs from source');
}
const manifest = JSON.parse(archivedModelManifest.toString('utf8'));
const required = [
	'THIRD_PARTY_NOTICES.txt',
	modelManifestPath,
	...manifest.files.map((file) => `assets/vietnamese-normalizer/${file.path}`),
];
for (const path of required) {
	if (!files.has(path)) {
		throw new Error(`Release archive is missing ${path}`);
	}
}
for (const file of manifest.files) {
	const path = `assets/vietnamese-normalizer/${file.path}`;
	const archived = readArchivedFile(path);
	const source = readFileSync(`public/${path}`);
	const sha256 = createHash('sha256').update(archived).digest('hex');
	if (archived.length !== file.bytes || sha256 !== file.sha256) {
		throw new Error(`Archived asset checksum/size mismatch for ${file.path}`);
	}
	if (!archived.equals(source)) {
		throw new Error(`Archived asset differs from source: ${file.path}`);
	}
}
for (const path of ['manifest.json', 'THIRD_PARTY_NOTICES.txt']) {
	if (!files.has(path)) {
		throw new Error(`Release archive is missing ${path}`);
	}
	if (!readArchivedFile(path).equals(readFileSync(`dist/${path}`))) {
		throw new Error(`Archived ${path} differs from the production build`);
	}
}

const runtimeFiles = [...files].filter((path) => path.endsWith('.mjs') || path.endsWith('.wasm')).sort();
const allowed = new Set(['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']);
const unexpected = runtimeFiles.filter((path) => !allowed.has(path) && !/^static\/assets\/ort\.webgpu\.min\.[a-f0-9]+\.mjs$/u.test(path));
if (unexpected.length > 0) {
	throw new Error(`Release archive contains unexpected ONNX Runtime files: ${unexpected.join(', ')}`);
}
for (const path of allowed) {
	if (!files.has(path)) {
		throw new Error(`Release archive is missing ${path}`);
	}
}
if (!runtimeFiles.some((path) => /^static\/assets\/ort\.webgpu\.min\.[a-f0-9]+\.mjs$/u.test(path))) {
	throw new Error('Release archive is missing the verified bundled ONNX Runtime WebGPU frontend');
}
for (const path of runtimeFiles) {
	if (!readArchivedFile(path).equals(readFileSync(`dist/${path}`))) {
		throw new Error(`Archived ONNX Runtime file differs from the production build: ${path}`);
	}
}
process.stdout.write(`${JSON.stringify({ archive, normalizerAssets: manifest.files.length, runtimeFiles })}\n`);
