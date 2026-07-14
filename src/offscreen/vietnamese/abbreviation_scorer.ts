import type * as Ort from 'onnxruntime-web';
import * as browserOrt from 'onnxruntime-web/webgpu';

import type { AbbreviationScorer } from './abbreviations.ts';

if (typeof chrome !== 'undefined' && chrome.runtime) {
	browserOrt.env.wasm.wasmPaths = {
		mjs: chrome.runtime.getURL('ort-wasm-simd-threaded.asyncify.mjs'),
		wasm: chrome.runtime.getURL('ort-wasm-simd-threaded.asyncify.wasm'),
	};
	browserOrt.env.wasm.numThreads = 1;
	browserOrt.env.wasm.proxy = false;
}

export interface AbbreviationScorerConfig {
	window_size: number;
	seq_len: number;
	vocab: Readonly<Record<string, number>>;
}

type OrtRuntime = Pick<typeof browserOrt, 'InferenceSession' | 'Tensor'>;

export class OnnxAbbreviationScorer implements AbbreviationScorer {
	private readonly session: Ort.InferenceSession;
	private readonly config: AbbreviationScorerConfig;
	private readonly runtime: OrtRuntime;

	private constructor(session: Ort.InferenceSession, config: AbbreviationScorerConfig, runtime: OrtRuntime) {
		this.session = session;
		this.config = config;
		this.runtime = runtime;
	}

	static async create(modelSource: string | Uint8Array, config: AbbreviationScorerConfig): Promise<AbbreviationScorer> {
		return OnnxAbbreviationScorer.createWithRuntime(modelSource, config, browserOrt);
	}

	static async createWithRuntime(
		modelSource: string | Uint8Array,
		config: AbbreviationScorerConfig,
		runtime: OrtRuntime,
	): Promise<AbbreviationScorer> {
		if (typeof modelSource === 'string' && !/^(chrome|moz)-extension:\/\//u.test(modelSource)) {
			throw new Error('Abbreviation model URL must be extension-local');
		}
		if (
			!Number.isSafeInteger(config.window_size) ||
			config.window_size < 0 ||
			!Number.isSafeInteger(config.seq_len) ||
			config.seq_len <= 0
		) {
			throw new Error('Invalid abbreviation scorer config');
		}
		const options: Ort.InferenceSession.SessionOptions = {
			executionProviders: ['wasm'],
			graphOptimizationLevel: 'all',
		};
		const session =
			typeof modelSource === 'string'
				? await runtime.InferenceSession.create(modelSource, options)
				: await runtime.InferenceSession.create(modelSource, options);
		return new OnnxAbbreviationScorer(session, config, runtime);
	}

	async score(candidates: readonly string[], leftContext: string, rightContext: string): Promise<readonly number[]> {
		if (candidates.length === 0) {
			return [];
		}
		const left = leftContext.split(/\s+/u).filter(Boolean).slice(-this.config.window_size).join(' ');
		const right = rightContext.split(/\s+/u).filter(Boolean).slice(0, this.config.window_size).join(' ');
		const pad = this.config.vocab['<pad>'];
		const unknown = this.config.vocab['<unk>'];
		if (!Number.isSafeInteger(pad) || !Number.isSafeInteger(unknown)) {
			throw new Error('Abbreviation vocab lacks pad/unknown tokens');
		}
		const data = new BigInt64Array(candidates.length * this.config.seq_len);
		for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
			const example = `${left} ${candidates[candidateIndex].toLowerCase()} ${right}`.trim();
			const ids = example
				.split(/\s+/u)
				.filter(Boolean)
				.map((token) => this.config.vocab[token] ?? unknown);
			for (let tokenIndex = 0; tokenIndex < this.config.seq_len; tokenIndex++) {
				data[candidateIndex * this.config.seq_len + tokenIndex] = BigInt(ids[tokenIndex] ?? pad);
			}
		}
		const inputName = this.session.inputNames[0];
		const outputName = this.session.outputNames[0];
		if (!inputName || !outputName) {
			throw new Error('Abbreviation scorer model has no input/output');
		}
		const result = await this.session.run({
			[inputName]: new this.runtime.Tensor('int64', data, [candidates.length, this.config.seq_len]),
		});
		const scores: number[] = [];
		for (const value of result[outputName].data) {
			scores.push(Number(value));
		}
		if (scores.length !== candidates.length || scores.some((score) => !Number.isFinite(score))) {
			throw new Error('Invalid abbreviation scorer output');
		}
		return scores;
	}
}
