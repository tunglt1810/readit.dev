import * as ort from 'onnxruntime-web/webgpu';

import { fetchWithCache } from '../shared/model_cache.ts';

// Set WebAssembly paths to the extension root where the .wasm files are copied
ort.env.wasm.wasmPaths = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.getURL('/') : '/';

// Disable multi-threading in Chrome Extension environment to avoid Blob URL CSP / importScripts errors
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

// Available languages for multilingual TTS
export const AVAILABLE_LANGS = [
	'en',
	'ko',
	'ja',
	'ar',
	'bg',
	'cs',
	'da',
	'de',
	'el',
	'es',
	'et',
	'fi',
	'fr',
	'hi',
	'hr',
	'hu',
	'id',
	'it',
	'lt',
	'lv',
	'nl',
	'pl',
	'pt',
	'ro',
	'ru',
	'sk',
	'sl',
	'sv',
	'tr',
	'uk',
	'vi',
	'na',
];

export function isValidLang(lang: string): boolean {
	return AVAILABLE_LANGS.includes(lang);
}

export function resolveLanguage(lang: string): string {
	return isValidLang(lang) ? lang : 'na';
}

/**
 * Maximum rendering length accepted by a single synthesis request. The limit follows the language
 * resolved by the TTS engine so planning and synthesis share one capacity policy.
 */
export function synthesisTextLimitForLanguage(language: string): number {
	const resolvedLanguage = resolveLanguage(language);
	return resolvedLanguage === 'ko' || resolvedLanguage === 'ja' ? 120 : 300;
}

export function finalRenderingText(unit: { text: string; synthesisText?: string }): string {
	return unit.synthesisText ?? unit.text;
}

export class SynthesisCapacityError extends RangeError {
	readonly code = 'SYNTHESIS_CAPACITY_EXCEEDED';

	constructor(renderingLength: number, limit: number, language: string) {
		super(`Unit Final Rendering length (${renderingLength}) exceeds synthesis capacity limit of ${limit} for language '${language}'`);
		this.name = 'SynthesisCapacityError';
	}
}

export function assertWithinSynthesisCapacity(unit: { text: string; synthesisText?: string }, language: string): void {
	const limit = synthesisTextLimitForLanguage(language);
	const rendering = finalRenderingText(unit);
	if (rendering.length > limit) {
		throw new SynthesisCapacityError(rendering.length, limit, language);
	}
}
// Interface for configuration
export interface TTSConfig {
	ae: {
		sample_rate: number;
		base_chunk_size: number;
	};
	ttl: {
		chunk_compress_factor: number;
		latent_dim: number;
	};
}

/**
 * Unicode Text Processor
 */
export class UnicodeProcessor {
	private indexer: Record<number, number>;

	constructor(indexer: Record<number, number>) {
		this.indexer = indexer;
	}

	call(textList: string[], langList: string[]) {
		const processedTexts = textList.map((text, i) => this.preprocessText(text, langList[i]));
		const textIdsLengths = processedTexts.map((text) => text.length);
		const maxLen = Math.max(...textIdsLengths);

		const textIds = processedTexts.map((text) => {
			const row = new Array<number>(maxLen).fill(0);
			for (let j = 0; j < text.length; j++) {
				const codePoint = text.codePointAt(j);
				if (codePoint !== undefined) {
					row[j] = codePoint < Object.keys(this.indexer).length ? this.indexer[codePoint] : -1;
				} else {
					row[j] = -1;
				}
			}
			return row;
		});

		const textMask = this.getTextMask(textIdsLengths);
		return { textIds, textMask };
	}

	preprocessText(text: string, lang: string): string {
		text = text.normalize('NFKD');

		// Remove emojis (wide Unicode range)
		const emojiPattern =
			/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
		text = text.replace(emojiPattern, '');

		// Replace various dashes and symbols
		const replacements: Record<string, string> = {
			'–': '-',
			'‑': '-',
			'—': '-',
			_: ' ',
			'\u201C': '"',
			'\u201D': '"',
			'\u2018': "'",
			'\u2019': "'",
			'´': "'",
			'`': "'",
			'[': ' ',
			']': ' ',
			'|': ' ',
			'/': ' ',
			'#': ' ',
			'→': ' ',
			'←': ' ',
		};
		for (const [k, v] of Object.entries(replacements)) {
			text = text.replaceAll(k, v);
		}

		// Remove special symbols
		text = text.replace(/[♥☆♡©\\]/g, '');

		// Replace known expressions and symbols
		const andReplacement = lang === 'vi' ? ' và ' : ' and ';
		const exprReplacements: Record<string, string> = {
			'&': andReplacement,
			'@': ' at ',
			'e.g.,': 'for example, ',
			'i.e.,': 'that is, ',
		};
		for (const [k, v] of Object.entries(exprReplacements)) {
			text = text.replaceAll(k, v);
		}

		// Fix spacing around punctuation
		text = text.replace(/ ,/g, ',');
		text = text.replace(/ \./g, '.');
		text = text.replace(/ !/g, '!');
		text = text.replace(/ \?/g, '?');
		text = text.replace(/ ;/g, ';');
		text = text.replace(/ :/g, ':');
		text = text.replace(/ '/g, "'");

		// Remove duplicate quotes
		while (text.includes('""')) {
			text = text.replace('""', '"');
		}
		while (text.includes("''")) {
			text = text.replace("''", "'");
		}
		while (text.includes('``')) {
			text = text.replace('``', '`');
		}

		// Remove extra spaces
		text = text.replace(/\s+/g, ' ').trim();

		// If text doesn't end with sentence-ending punctuation (or punctuation followed by closing quotes/brackets), add a period
		if (!/[.!?…](?:['"'\)\]}”’]*)$/u.test(text)) {
			text += '.';
		}

		// Validate language
		if (!isValidLang(lang)) {
			throw new Error(`Invalid language: ${lang}. Available: ${AVAILABLE_LANGS.join(', ')}`);
		}

		// Wrap text with language tags (with space before closing tag to ensure tail decay frames in duration predictor)
		text = `<${lang}>${text} </${lang}>`;

		return text;
	}

	getTextMask(textIdsLengths: number[]) {
		const maxLen = Math.max(...textIdsLengths);
		return this.lengthToMask(textIdsLengths, maxLen);
	}

	lengthToMask(lengths: number[], maxLen: number | null = null): number[][][] {
		const actualMaxLen = maxLen || Math.max(...lengths);
		return lengths.map((len) => {
			const row = new Array<number>(actualMaxLen).fill(0.0);
			for (let j = 0; j < Math.min(len, actualMaxLen); j++) {
				row[j] = 1.0;
			}
			return [row];
		});
	}
}

/**
 * Style class to hold TTL and DP tensors
 */
export class Style {
	ttl: ort.Tensor;
	dp: ort.Tensor;

	constructor(ttlTensor: ort.Tensor, dpTensor: ort.Tensor) {
		this.ttl = ttlTensor;
		this.dp = dpTensor;
	}
}

function repeatStyleBatch(tensor: ort.Tensor, batchSize: number): ort.Tensor {
	if (tensor.dims[0] === batchSize) {
		return tensor;
	}
	if (tensor.dims[0] !== 1 || tensor.type !== 'float32' || !(tensor.data instanceof Float32Array)) {
		throw new Error('Duration prediction requires one float32 style tensor to repeat across the text batch');
	}
	const repeated = new Float32Array(tensor.data.length * batchSize);
	for (let batchIndex = 0; batchIndex < batchSize; batchIndex++) {
		repeated.set(tensor.data, batchIndex * tensor.data.length);
	}
	return new ort.Tensor('float32', repeated, [batchSize, ...tensor.dims.slice(1)]);
}

/**
 * Text-to-Speech class
 */
export class TextToSpeech {
	cfgs: TTSConfig;
	textProcessor: UnicodeProcessor;
	dpOrt: ort.InferenceSession;
	textEncOrt: ort.InferenceSession;
	vectorEstOrt: ort.InferenceSession;
	vocoderOrt: ort.InferenceSession;
	sampleRate: number;

	constructor(
		cfgs: TTSConfig,
		textProcessor: UnicodeProcessor,
		dpOrt: ort.InferenceSession,
		textEncOrt: ort.InferenceSession,
		vectorEstOrt: ort.InferenceSession,
		vocoderOrt: ort.InferenceSession,
	) {
		this.cfgs = cfgs;
		this.textProcessor = textProcessor;
		this.dpOrt = dpOrt;
		this.textEncOrt = textEncOrt;
		this.vectorEstOrt = vectorEstOrt;
		this.vocoderOrt = vocoderOrt;
		this.sampleRate = cfgs.ae.sample_rate;
	}

	private async prepareDurationPrediction(textList: string[], langList: string[], style: Style, speed: number) {
		const bsz = textList.length;
		const { textIds, textMask } = this.textProcessor.call(textList, langList);

		const textIdsFlat = new BigInt64Array(textIds.flat().map((x) => BigInt(x)));
		const textIdsShape = [bsz, textIds[0].length];
		const textIdsTensor = new ort.Tensor('int64', textIdsFlat, textIdsShape);

		const textMaskFlat = new Float32Array(textMask.flat(2));
		const textMaskShape = [bsz, 1, textMask[0][0].length];
		const textMaskTensor = new ort.Tensor('float32', textMaskFlat, textMaskShape);

		const dpOutputs = await this.dpOrt.run({
			text_ids: textIdsTensor,
			style_dp: repeatStyleBatch(style.dp, bsz),
			text_mask: textMaskTensor,
		});
		const duration = Array.from(dpOutputs.duration.data as Float32Array, (value) => value / speed);

		return { duration, textIdsTensor, textMaskTensor };
	}

	async predictDurations(textList: string[], langList: string[], style: Style, speed = 1.05): Promise<number[]> {
		const { duration } = await this.prepareDurationPrediction(textList, langList, style, speed);
		return duration;
	}

	async _infer(
		textList: string[],
		langList: string[],
		style: Style,
		totalStep: number,
		speed = 1.05,
		progressCallback?: (step: number, total: number) => void,
	) {
		const bsz = textList.length;
		const { duration, textIdsTensor, textMaskTensor } = await this.prepareDurationPrediction(textList, langList, style, speed);

		// Encode text
		const textEncOutputs = await this.textEncOrt.run({
			text_ids: textIdsTensor,
			style_ttl: style.ttl,
			text_mask: textMaskTensor,
		});
		const textEmb = textEncOutputs.text_emb;

		// Sample noisy latent
		const {
			xt: initialLatent,
			latentMask,
			latentDim: latentRows,
			latentLen,
		} = this.sampleNoisyLatent(
			duration,
			this.sampleRate,
			this.cfgs.ae.base_chunk_size,
			this.cfgs.ttl.chunk_compress_factor,
			this.cfgs.ttl.latent_dim,
		);
		// Widened because each step replaces it with the denoiser's own output, which makes no promise
		// about the kind of buffer backing it.
		let xt: Float32Array<ArrayBufferLike> = initialLatent;
		const xtShape = [bsz, latentRows, latentLen];

		const latentMaskFlat = new Float32Array(latentMask.flat(2));
		const latentMaskShape = [bsz, 1, latentMask[0][0].length];
		const latentMaskTensor = new ort.Tensor('float32', latentMaskFlat, latentMaskShape);

		// Prepare constant arrays
		const totalStepArray = new Float32Array(bsz).fill(totalStep);
		const totalStepTensor = new ort.Tensor('float32', totalStepArray, [bsz]);

		// Denoising loop
		for (let step = 0; step < totalStep; step++) {
			if (progressCallback) {
				progressCallback(step + 1, totalStep);
			}

			const currentStepArray = new Float32Array(bsz).fill(step);
			const currentStepTensor = new ort.Tensor('float32', currentStepArray, [bsz]);

			const xtTensor = new ort.Tensor('float32', xt, xtShape);

			const vectorEstOutputs = await this.vectorEstOrt.run({
				noisy_latent: xtTensor,
				text_emb: textEmb,
				style_ttl: style.ttl,
				latent_mask: latentMaskTensor,
				text_mask: textMaskTensor,
				current_step: currentStepTensor,
				total_step: totalStepTensor,
			});

			// The denoiser returns the shape it was handed, already flat and row-major, so it becomes
			// the next step's latent untouched. Unpacking it into nested arrays only to flatten them
			// again allocated the whole latent twice per step — about 6 MB a step, measured.
			xt = vectorEstOutputs.denoised_latent.data as Float32Array;
		}

		// Generate waveform
		const vocoderOutputs = await this.vocoderOrt.run({
			latent: new ort.Tensor('float32', xt, xtShape),
		});

		// Handed on as the vocoder's own Float32Array. Copying it into a JS number[] here doubled the
		// footprint of every unit — eight bytes a sample instead of four — for a buffer that is copied
		// into an AudioBuffer moments later anyway.
		const wav = vocoderOutputs.wav_tts.data as Float32Array;

		return { wav, duration };
	}

	async call(
		text: string,
		lang: string,
		style: Style,
		totalStep: number,
		speed = 1.05,
		silenceDuration = 0.3,
		progressCallback?: (step: number, total: number) => void,
	) {
		if (style.ttl.dims[0] !== 1) {
			throw new Error('Single speaker text to speech only supports single style');
		}
		const resolvedLang = resolveLanguage(lang);
		const maxLen = resolvedLang === 'ko' || resolvedLang === 'ja' ? 120 : 300;
		const textList = chunkText(text, maxLen);
		const langList = new Array<string>(textList.length).fill(resolvedLang);
		// Collected and joined once at the end. Growing the result chunk by chunk reallocated and
		// recopied every sample already produced, and a single chunk — the usual case — is returned
		// untouched.
		const chunks: Float32Array[] = [];
		const silenceLen = Math.floor(silenceDuration * this.sampleRate);
		let durCat = 0;

		for (let i = 0; i < textList.length; i++) {
			const { wav, duration } = await this._infer([textList[i]], [langList[i]], style, totalStep, speed, progressCallback);

			if (chunks.length > 0) {
				chunks.push(new Float32Array(silenceLen));
				durCat += silenceDuration;
			}
			chunks.push(wav);
			durCat += duration[0];
		}

		if (chunks.length === 1) {
			return { wav: chunks[0], duration: [durCat] };
		}

		const wavCat = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
		let offset = 0;
		for (const chunk of chunks) {
			wavCat.set(chunk, offset);
			offset += chunk.length;
		}
		return { wav: wavCat, duration: [durCat] };
	}

	sampleNoisyLatent(duration: number[], sampleRate: number, baseChunkSize: number, chunkCompress: number, latentDim: number) {
		const bsz = duration.length;
		const maxDur = Math.max(...duration);

		const wavLenMax = Math.floor(maxDur * sampleRate);
		const wavLengths = duration.map((d) => Math.floor(d * sampleRate));

		const chunkSize = baseChunkSize * chunkCompress;
		const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
		const latentDimVal = latentDim * chunkCompress;

		const latentLengths = wavLengths.map((len) => Math.floor((len + chunkSize - 1) / chunkSize));
		const latentMask = this.lengthToMask(latentLengths, latentLen);

		// Flat and row-major: the layout the tensor takes, and the one the denoiser hands back. The
		// mask is applied as each sample is drawn rather than in a second pass over the whole latent.
		const xt = new Float32Array(bsz * latentDimVal * latentLen);
		for (let b = 0; b < bsz; b++) {
			const mask = latentMask[b][0];
			for (let d = 0; d < latentDimVal; d++) {
				const rowStart = (b * latentDimVal + d) * latentLen;
				for (let t = 0; t < latentLen; t++) {
					// Box-Muller transform
					const u1 = Math.max(0.0001, Math.random());
					const u2 = Math.random();
					xt[rowStart + t] = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2) * mask[t];
				}
			}
		}

		return { xt, latentMask, latentDim: latentDimVal, latentLen };
	}

	lengthToMask(lengths: number[], maxLen: number | null = null): number[][][] {
		const actualMaxLen = maxLen || Math.max(...lengths);
		return lengths.map((len) => {
			const row = new Array<number>(actualMaxLen).fill(0.0);
			for (let j = 0; j < Math.min(len, actualMaxLen); j++) {
				row[j] = 1.0;
			}
			return [row];
		});
	}
}

/**
 * Load voice style from JSON files (fetch relative paths inside extension)
 */
export async function loadVoiceStyle(voiceStylePaths: string[]): Promise<Style> {
	const bsz = voiceStylePaths.length;

	const firstResponse = await fetch(voiceStylePaths[0]);
	const firstStyle = await firstResponse.json();

	const ttlDims = firstStyle.style_ttl.dims;
	const dpDims = firstStyle.style_dp.dims;

	const ttlDim1 = ttlDims[1];
	const ttlDim2 = ttlDims[2];
	const dpDim1 = dpDims[1];
	const dpDim2 = dpDims[2];

	const ttlSize = bsz * ttlDim1 * ttlDim2;
	const dpSize = bsz * dpDim1 * dpDim2;
	const ttlFlat = new Float32Array(ttlSize);
	const dpFlat = new Float32Array(dpSize);

	for (let i = 0; i < bsz; i++) {
		const response = await fetch(voiceStylePaths[i]);
		const voiceStyle = await response.json();

		const ttlData = voiceStyle.style_ttl.data.flat(Infinity);
		const ttlOffset = i * ttlDim1 * ttlDim2;
		ttlFlat.set(ttlData, ttlOffset);

		const dpData = voiceStyle.style_dp.data.flat(Infinity);
		const dpOffset = i * dpDim1 * dpDim2;
		dpFlat.set(dpData, dpOffset);
	}

	const ttlShape = [bsz, ttlDim1, ttlDim2];
	const dpShape = [bsz, dpDim1, dpDim2];

	const ttlTensor = new ort.Tensor('float32', ttlFlat, ttlShape);
	const dpTensor = new ort.Tensor('float32', dpFlat, dpShape);

	return new Style(ttlTensor, dpTensor);
}

/**
 * Load configuration from CDN / HuggingFace via cache
 */
export async function loadCfgs(url: string): Promise<TTSConfig> {
	const buffer = await fetchWithCache(url);
	const textDecoder = new TextDecoder('utf-8');
	const jsonText = textDecoder.decode(buffer);
	const cfgs = JSON.parse(jsonText) as TTSConfig;
	return cfgs;
}

/**
 * Load text processor indexer via cache
 */
export async function loadTextProcessor(url: string): Promise<UnicodeProcessor> {
	const buffer = await fetchWithCache(url);
	const textDecoder = new TextDecoder('utf-8');
	const jsonText = textDecoder.decode(buffer);
	const indexer = JSON.parse(jsonText) as Record<number, number>;
	return new UnicodeProcessor(indexer);
}

/**
 * Load ONNX model via cache and build InferenceSession
 */
export async function loadOnnx(
	url: string,
	options: ort.InferenceSession.SessionOptions,
	progressCallback?: (loadedBytes: number, totalBytes: number) => void,
): Promise<ort.InferenceSession> {
	const buffer = await fetchWithCache(url, progressCallback);
	const session = await ort.InferenceSession.create(buffer, options);
	return session;
}

export interface ModelLoadProgress {
	modelName: string;
	loaded: number;
	total: number;
}

/**
 * Load all TTS components from HuggingFace, caching locally
 */
export async function loadTextToSpeech(
	modelUrls: {
		durationPredictor: string;
		textEncoder: string;
		vectorEstimator: string;
		vocoder: string;
		unicodeIndexer: string;
		ttsJson: string;
	},
	sessionOptions: ort.InferenceSession.SessionOptions = {},
	progressCallback?: (loadedBytes: number, totalBytes: number, activeModel: string) => void,
): Promise<{ textToSpeech: TextToSpeech; cfgs: TTSConfig }> {
	// Load small metadata configs
	const cfgs = await loadCfgs(modelUrls.ttsJson);
	const textProcessor = await loadTextProcessor(modelUrls.unicodeIndexer);

	const modelPaths = [
		{ name: 'Duration Predictor', url: modelUrls.durationPredictor },
		{ name: 'Text Encoder', url: modelUrls.textEncoder },
		{ name: 'Vector Estimator', url: modelUrls.vectorEstimator },
		{ name: 'Vocoder', url: modelUrls.vocoder },
	];

	const sessions: ort.InferenceSession[] = [];
	for (let i = 0; i < modelPaths.length; i++) {
		const model = modelPaths[i];
		const session = await loadOnnx(
			model.url,
			sessionOptions,
			progressCallback ? (loaded: number, total: number) => progressCallback(loaded, total, model.name) : undefined,
		);
		sessions.push(session);
	}

	const [dpOrt, textEncOrt, vectorEstOrt, vocoderOrt] = sessions;
	const textToSpeech = new TextToSpeech(cfgs, textProcessor, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt);

	return { textToSpeech, cfgs };
}

/**
 * Chunk text into manageable segments
 */
export function chunkText(text: string, maxLen = 300): string[] {
	if (typeof text !== 'string') {
		throw new Error(`chunkText expects a string, got ${typeof text}`);
	}

	const paragraphs = text
		.trim()
		.split(/\n\s*\n+/)
		.filter((p) => p.trim());
	const chunks: string[] = [];

	for (let paragraph of paragraphs) {
		paragraph = paragraph.trim();
		if (!paragraph) {
			continue;
		}

		const sentences = paragraph.split(
			/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/,
		);
		let currentChunk = '';

		for (const sentence of sentences) {
			if (currentChunk.length + sentence.length + 1 <= maxLen) {
				currentChunk += (currentChunk ? ' ' : '') + sentence;
			} else {
				if (currentChunk) {
					chunks.push(currentChunk.trim());
				}
				currentChunk = sentence;
			}
		}

		if (currentChunk) {
			chunks.push(currentChunk.trim());
		}
	}

	return chunks;
}
