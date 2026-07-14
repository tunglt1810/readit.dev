export interface AbbreviationScorer {
	score(candidates: readonly string[], leftContext: string, rightContext: string): Promise<readonly number[]>;
}

export interface AbbreviationExpansionRequest {
	source: string;
	leftContext: string;
	rightContext: string;
	dictionary: ReadonlyMap<string, readonly string[]>;
	scorer: AbbreviationScorer | null;
	confidenceThreshold: number;
	confidenceMargin: number;
}

const LETTER_NAMES: Readonly<Record<string, string>> = {
	A: 'a',
	Ă: 'á',
	Â: 'ớ',
	B: 'bê',
	C: 'xê',
	D: 'đê',
	Đ: 'đê',
	E: 'e',
	Ê: 'ê',
	F: 'ép',
	G: 'gờ',
	H: 'hát',
	I: 'i',
	J: 'di',
	K: 'ca',
	L: 'lờ',
	M: 'mờ',
	N: 'nờ',
	O: 'o',
	Ô: 'ô',
	Ơ: 'ơ',
	P: 'pê',
	Q: 'quy',
	R: 'rờ',
	S: 'ét',
	T: 'tê',
	U: 'u',
	Ư: 'ư',
	V: 'vê',
	W: 'vê kép',
	X: 'ích',
	Y: 'y',
	Z: 'dét',
};

export function parseAbbreviationDictionary(text: string): ReadonlyMap<string, readonly string[]> {
	const dictionary = new Map<string, string[]>();
	for (const rawLine of text.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (line.length === 0) {
			continue;
		}
		const separator = line.indexOf(':');
		if (separator <= 0) {
			throw new Error(`malformed abbreviation record: ${rawLine}`);
		}
		const key = line.slice(0, separator).trim();
		const candidates = line
			.slice(separator + 1)
			.split(',')
			.map((candidate) => candidate.trim())
			.filter(Boolean);
		if (key.length === 0 || candidates.length === 0) {
			throw new Error(`malformed abbreviation record: ${rawLine}`);
		}
		const merged = dictionary.get(key) ?? [];
		for (const candidate of candidates) {
			if (!merged.includes(candidate)) {
				merged.push(candidate);
			}
		}
		dictionary.set(key, merged);
	}
	return dictionary;
}

function lookupCandidates(source: string, dictionary: ReadonlyMap<string, readonly string[]>): readonly string[] | undefined {
	const keys = [source, source.replaceAll('.', ''), source.split(/[.-]+/u).join('')];
	for (const key of keys) {
		const candidates = dictionary.get(key);
		if (candidates) {
			return candidates;
		}
	}
	return undefined;
}

function safeLetterSequence(source: string): string | null {
	if (!/^[A-ZĐĂÂÊÔƠƯ]+(?:\.[A-ZĐĂÂÊÔƠƯ]+)*$/u.test(source)) {
		return null;
	}
	const letters = Array.from(source.replaceAll('.', ''));
	if (letters.length < 2 || letters.length > 8 || letters.some((letter) => !LETTER_NAMES[letter])) {
		return null;
	}
	return letters.map((letter) => LETTER_NAMES[letter]).join(' ');
}

function probabilities(logits: readonly number[]): number[] | null {
	if (logits.length === 0 || logits.some((score) => typeof score !== 'number' || !Number.isFinite(score))) {
		return null;
	}
	const maximum = Math.max(...logits);
	const exponentials = logits.map((score) => Math.exp(score - maximum));
	const total = exponentials.reduce((sum, score) => sum + score, 0);
	return Number.isFinite(total) && total > 0 ? exponentials.map((score) => score / total) : null;
}

export interface AbbreviationCalibrationSample {
	scores: readonly number[];
	expectedIndex: number;
}

export function calibrateAbbreviationConfidence(samples: readonly AbbreviationCalibrationSample[]): {
	confidenceThreshold: number;
	confidenceMargin: number;
	correctAccepted: number;
} {
	let best = { confidenceThreshold: 0.95, confidenceMargin: 0.3, correctAccepted: -1 };
	for (let thresholdPercent = 50; thresholdPercent <= 95; thresholdPercent++) {
		for (let marginPercent = 5; marginPercent <= 30; marginPercent++) {
			const confidenceThreshold = thresholdPercent / 100;
			const confidenceMargin = marginPercent / 100;
			let correctAccepted = 0;
			let wrongAccepted = 0;
			for (const sample of samples) {
				const confidence = probabilities(sample.scores);
				if (!confidence || confidence.length !== sample.scores.length) {
					continue;
				}
				const order = confidence
					.map((value, index) => ({ value, index }))
					.sort((left, right) => right.value - left.value || left.index - right.index);
				if (order[0].value < confidenceThreshold || order[0].value - (order[1]?.value ?? 0) < confidenceMargin) {
					continue;
				}
				if (order[0].index === sample.expectedIndex) {
					correctAccepted++;
				} else {
					wrongAccepted++;
				}
			}
			if (wrongAccepted > 0) {
				continue;
			}
			if (
				correctAccepted > best.correctAccepted ||
				(correctAccepted === best.correctAccepted && confidenceThreshold > best.confidenceThreshold) ||
				(correctAccepted === best.correctAccepted &&
					confidenceThreshold === best.confidenceThreshold &&
					confidenceMargin > best.confidenceMargin)
			) {
				best = { confidenceThreshold, confidenceMargin, correctAccepted };
			}
		}
	}
	if (best.correctAccepted < 0) {
		throw new Error('No safe abbreviation calibration pair found');
	}
	return best;
}

export async function expandAbbreviation(request: AbbreviationExpansionRequest): Promise<string | null> {
	const source = request.source.trim();
	const candidates = lookupCandidates(source, request.dictionary);
	if (!candidates) {
		return safeLetterSequence(source);
	}
	if (candidates.length === 1) {
		return candidates[0];
	}
	if (!request.scorer) {
		return safeLetterSequence(source);
	}
	try {
		const scores = await request.scorer.score(candidates, request.leftContext, request.rightContext);
		if (scores.length !== candidates.length) {
			return safeLetterSequence(source);
		}
		const confidence = probabilities(scores);
		if (!confidence) {
			return safeLetterSequence(source);
		}
		const order = confidence
			.map((value, index) => ({ value, index }))
			.sort((left, right) => right.value - left.value || left.index - right.index);
		const best = order[0];
		const margin = best.value - (order[1]?.value ?? 0);
		if (best.value < request.confidenceThreshold || margin < request.confidenceMargin) {
			return safeLetterSequence(source);
		}
		return candidates[best.index] ?? safeLetterSequence(source);
	} catch {
		return safeLetterSequence(source);
	}
}
