import { type AbbreviationScorerConfig, OnnxAbbreviationScorer } from './abbreviation_scorer.ts';
import { parseAbbreviationDictionary } from './abbreviations.ts';
import { createCrfDetector, decodePortableCrfModel } from './crf.ts';
import { MEASUREMENT_UNIT_KEYS, MONEY_UNIT_KEYS } from './expanders.ts';
import type { CheckpointLabel, VietnameseNormalizerAssets } from './types.ts';

interface AssetRecord {
	path: string;
	bytes: number;
	sha256: string;
}

interface AssetManifest {
	formatVersion: number;
	labels: CheckpointLabel[];
	abbreviation: {
		confidenceThreshold: number;
		confidenceMargin: number;
	};
	files: AssetRecord[];
}

const FALLBACK_ASSETS: VietnameseNormalizerAssets = {
	detector: null,
	vietnameseSyllables: new Set(),
	abbreviations: new Map(),
	abbreviationScorer: null,
	confidenceThreshold: 1,
	confidenceMargin: 1,
};

let cachedAssets: VietnameseNormalizerAssets | undefined;
let inFlight: Promise<VietnameseNormalizerAssets> | undefined;

function assetUrl(path: string): string {
	return chrome.runtime.getURL(`assets/vietnamese-normalizer/${path}`);
}

function bytesToHex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchBytes(manifest: AssetManifest, path: string): Promise<Uint8Array> {
	const record = manifest.files.find((file) => file.path === path);
	if (!record || !Number.isSafeInteger(record.bytes) || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
		throw new Error(`Missing asset metadata: ${path}`);
	}
	const response = await fetch(assetUrl(path));
	if (!response.ok) {
		throw new Error(`Unable to load Vietnamese asset: ${path}`);
	}
	const data = await response.arrayBuffer();
	if (data.byteLength !== record.bytes) {
		throw new Error(`Vietnamese asset size mismatch: ${path}`);
	}
	const digest = await crypto.subtle.digest('SHA-256', data);
	if (bytesToHex(digest) !== record.sha256) {
		throw new Error(`Vietnamese asset checksum mismatch: ${path}`);
	}
	return new Uint8Array(data);
}

function decodeText(data: Uint8Array): string {
	return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

async function loadAssets(): Promise<VietnameseNormalizerAssets> {
	let manifest: AssetManifest;
	try {
		const response = await fetch(assetUrl('model-manifest.json'));
		if (!response.ok) {
			throw new Error('Unable to load Vietnamese asset manifest');
		}
		manifest = (await response.json()) as AssetManifest;
		if (
			manifest.formatVersion !== 1 ||
			!Array.isArray(manifest.labels) ||
			manifest.labels.length === 0 ||
			!Array.isArray(manifest.files) ||
			!Number.isFinite(manifest.abbreviation?.confidenceThreshold) ||
			!Number.isFinite(manifest.abbreviation?.confidenceMargin)
		) {
			throw new Error('Invalid Vietnamese asset manifest');
		}
	} catch {
		return FALLBACK_ASSETS;
	}

	let vietnameseSyllables: ReadonlySet<string>;
	let abbreviations: ReadonlyMap<string, readonly string[]>;
	try {
		const [syllableBytes, abbreviationBytes] = await Promise.all([
			fetchBytes(manifest, 'vietnamese-syllables.txt'),
			fetchBytes(manifest, 'abbreviations.txt'),
		]);
		vietnameseSyllables = new Set(decodeText(syllableBytes).split(/\r?\n/u).filter(Boolean));
		abbreviations = parseAbbreviationDictionary(decodeText(abbreviationBytes));
	} catch {
		return FALLBACK_ASSETS;
	}

	let detector: VietnameseNormalizerAssets['detector'] = null;
	try {
		const binary = await fetchBytes(manifest, 'crf-model.bin');
		const buffer = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer;
		detector = createCrfDetector(decodePortableCrfModel(buffer, manifest.labels), {
			vietnameseSyllables,
			abbreviations: new Set(abbreviations.keys()),
			moneyUnits: MONEY_UNIT_KEYS,
			measurementUnits: MEASUREMENT_UNIT_KEYS,
		});
	} catch {
		detector = null;
	}

	let abbreviationScorer: VietnameseNormalizerAssets['abbreviationScorer'] = null;
	try {
		const [configBytes, modelBytes] = await Promise.all([
			fetchBytes(manifest, 'abbreviation-config.json'),
			fetchBytes(manifest, 'abbreviation-scorer.onnx'),
		]);
		const config = JSON.parse(decodeText(configBytes)) as AbbreviationScorerConfig;
		abbreviationScorer = await OnnxAbbreviationScorer.create(modelBytes, config);
	} catch {
		abbreviationScorer = null;
	}

	return {
		detector,
		vietnameseSyllables,
		abbreviations,
		abbreviationScorer,
		confidenceThreshold: manifest.abbreviation.confidenceThreshold,
		confidenceMargin: manifest.abbreviation.confidenceMargin,
	};
}

export function loadVietnameseNormalizerAssets(): Promise<VietnameseNormalizerAssets> {
	if (cachedAssets) {
		return Promise.resolve(cachedAssets);
	}
	if (inFlight) {
		return inFlight;
	}
	inFlight = loadAssets().then((assets) => {
		cachedAssets = assets;
		return assets;
	});
	return inFlight.finally(() => {
		inFlight = undefined;
	});
}
