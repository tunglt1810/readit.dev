import { loadVietnameseNormalizerAssets } from '../../src/offscreen/vietnamese/assets.ts';
import { normalizeVietnameseText } from '../../src/offscreen/vietnamese/normalizer.ts';
import { tokenizeVietnameseText } from '../../src/offscreen/vietnamese/tokenizer.ts';
import type { NormalizationDiagnostics } from '../../src/offscreen/vietnamese/types.ts';

interface SizeReport {
	tokenCount: number;
	tokenizeFeatures: { p50: number; p95: number };
	viterbi: { p50: number; p95: number };
	expansion: { p50: number; p95: number };
	total: { p50: number; p95: number };
}

function percentile(values: readonly number[], ratio: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function phase(values: readonly number[]): { p50: number; p95: number } {
	return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function representativeArticle(targetTokens: number): string {
	const sentence = 'Bản tin công bố ngày 11/07/2026 tỷ lệ 12,5%, quãng đường 10-12 km, lúc 08:30, phiên bản v1.2.3.';
	const tokensPerSentence = tokenizeVietnameseText(sentence).paragraphs[0].tokens.length;
	return `ĐH mở đăng ký. ${Array.from({ length: Math.ceil(targetTokens / tokensPerSentence) }, () => sentence).join(' ')}`;
}

async function runSize(
	label: string,
	text: string,
	assets: Awaited<ReturnType<typeof loadVietnameseNormalizerAssets>>,
): Promise<SizeReport> {
	for (let index = 0; index < 3; index++) await normalizeVietnameseText(text, { assets, now: () => performance.now() });
	console.info(`${label}:warm`);
	const diagnostics: NormalizationDiagnostics[] = [];
	for (let index = 0; index < 20; index++) {
		diagnostics.push((await normalizeVietnameseText(text, { assets, now: () => performance.now() })).diagnostics);
		if ((index + 1) % 5 === 0) {
			const latest = diagnostics.at(-1);
			console.info(
				`${label}:measured=${index + 1} totalMs=${latest?.totalMs.toFixed(2)} crfMs=${latest?.crfMs.toFixed(2)} expansionMs=${latest?.expansionMs.toFixed(2)}`,
			);
		}
	}
	return {
		tokenCount: diagnostics[0]?.tokenCount ?? 0,
		tokenizeFeatures: phase(diagnostics.map((item) => Math.max(0, item.totalMs - item.crfMs - item.expansionMs))),
		viterbi: phase(diagnostics.map((item) => item.crfMs)),
		expansion: phase(diagnostics.map((item) => item.expansionMs)),
		total: phase(diagnostics.map((item) => item.totalMs)),
	};
}

async function benchmark() {
	const memoryBefore = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
	console.info('assets:start');
	const assets = await loadVietnameseNormalizerAssets();
	console.info(`assets:ready detector=${Boolean(assets.detector)} scorer=${Boolean(assets.abbreviationScorer)}`);
	const representative = await runSize('representative', representativeArticle(2_000), assets);
	console.info('representative:ready');
	const stress = await runSize('stress', representativeArticle(10_000), assets);
	console.info('stress:ready');
	const memoryAfter = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
	const budgetPassed = representative.total.p95 <= 50 && stress.total.p95 <= 150;
	const viterbiShare = stress.total.p95 > 0 ? stress.viterbi.p95 / stress.total.p95 : 0;
	const required = !budgetPassed && viterbiShare > 0.5;
	return {
		representative,
		stress,
		customViterbiWasm: {
			required,
			budgetPassed,
			viterbiShare,
			reason: budgetPassed
				? 'Both Chrome p95 normalization budgets passed; custom Viterbi WASM is not justified.'
				: viterbiShare > 0.5
					? 'A separate custom Viterbi WASM prototype plan is required before implementation.'
					: 'A normalization budget missed, but Viterbi is not the dominant cost.',
		},
		memory: {
			available: memoryBefore !== undefined && memoryAfter !== undefined,
			growthBytes: memoryBefore !== undefined && memoryAfter !== undefined ? memoryAfter - memoryBefore : null,
			stableAcrossRepeatedSessions: null,
		},
		warmTtfa: {
			available: false,
			ratio: null,
			reason: 'Requires a pre-warmed local Supertonic model cache and remains a release-device gate.',
		},
		ortRuntimeRequests: performance
			.getEntriesByType('resource')
			.map((entry) => entry.name)
			.filter((name) => /\.(?:mjs|wasm)(?:$|\?)/u.test(name))
			.map((name) => new URL(name).pathname.split('/').at(-1))
			.filter(Boolean)
			.sort(),
	};
}

Object.assign(globalThis, { __READIT_VI_BENCHMARK__: benchmark() });
