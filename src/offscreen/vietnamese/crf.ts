import { encodeCrfsuiteAttributes, extractCrfFeatures, type FeatureDictionaries } from './features.ts';
import { type CheckpointLabel, type DetectedSpan, NSW_TYPES, type SourceToken } from './types.ts';

export interface PortableCrfModel {
	formatVersion: 1;
	labels: CheckpointLabel[];
	stateFeatures: Array<[attribute: string, labelIndex: number, weight: number]>;
	transitionFeatures: Array<[fromLabelIndex: number, toLabelIndex: number, weight: number]>;
}

export interface CrfDetector {
	detect(tokens: readonly SourceToken[]): CheckpointLabel[];
}

const EMPTY_DICTIONARIES: FeatureDictionaries = {
	vietnameseSyllables: new Set(),
	abbreviations: new Set(),
	moneyUnits: new Set(),
	measurementUnits: new Set(),
};

export function decodePortableCrfModel(buffer: ArrayBuffer, rawLabels: readonly string[]): PortableCrfModel {
	const labels = [...rawLabels] as CheckpointLabel[];
	if (labels.length === 0 || labels.length > 32_767 || new Set(labels).size !== labels.length) {
		throw new Error('CRF labels must be non-empty and unique');
	}
	const view = new DataView(buffer);
	let offset = 0;
	const requireBytes = (count: number) => {
		if (offset + count > view.byteLength) {
			throw new Error('CRF binary is truncated');
		}
	};
	const uint8 = () => {
		requireBytes(1);
		return view.getUint8(offset++);
	};
	const uint16 = () => {
		requireBytes(2);
		const value = view.getUint16(offset, true);
		offset += 2;
		return value;
	};
	const uint32 = () => {
		requireBytes(4);
		const value = view.getUint32(offset, true);
		offset += 4;
		return value;
	};
	const float64 = () => {
		requireBytes(8);
		const value = view.getFloat64(offset, true);
		offset += 8;
		if (!Number.isFinite(value)) {
			throw new Error('CRF weights must be finite');
		}
		return value;
	};

	requireBytes(4);
	if (String.fromCharCode(uint8(), uint8(), uint8(), uint8()) !== 'VCRF') {
		throw new Error('Invalid CRF binary magic');
	}
	if (uint16() !== 1) {
		throw new Error('Unsupported CRF binary format version');
	}
	if (uint16() !== labels.length) {
		throw new Error('CRF binary label count does not match manifest');
	}
	const attributeCount = uint32();
	const stateCount = uint32();
	const transitionCount = uint32();
	const decoder = new TextDecoder('utf-8', { fatal: true });
	const attributes: string[] = [];
	for (let index = 0; index < attributeCount; index++) {
		const byteLength = uint32();
		requireBytes(byteLength);
		attributes.push(decoder.decode(new Uint8Array(buffer, offset, byteLength)));
		offset += byteLength;
	}

	const stateFeatures: PortableCrfModel['stateFeatures'] = [];
	for (let index = 0; index < stateCount; index++) {
		const attributeIndex = uint32();
		const labelIndex = uint8();
		if (uint8() !== 0 || uint8() !== 0 || uint8() !== 0) {
			throw new Error('CRF state record has non-zero padding');
		}
		const weight = float64();
		if (attributeIndex >= attributes.length || labelIndex >= labels.length) {
			throw new Error('CRF state record index is out of range');
		}
		stateFeatures.push([attributes[attributeIndex], labelIndex, weight]);
	}

	const transitionFeatures: PortableCrfModel['transitionFeatures'] = [];
	for (let index = 0; index < transitionCount; index++) {
		const fromLabelIndex = uint8();
		const toLabelIndex = uint8();
		if (uint8() !== 0 || uint8() !== 0) {
			throw new Error('CRF transition record has non-zero padding');
		}
		const weight = float64();
		if (fromLabelIndex >= labels.length || toLabelIndex >= labels.length) {
			throw new Error('CRF transition index is out of range');
		}
		transitionFeatures.push([fromLabelIndex, toLabelIndex, weight]);
	}
	if (offset !== view.byteLength) {
		throw new Error('CRF binary contains trailing bytes');
	}
	return { formatVersion: 1, labels, stateFeatures, transitionFeatures };
}

export function createCrfDetector(model: PortableCrfModel, dictionaries: FeatureDictionaries = EMPTY_DICTIONARIES): CrfDetector {
	const labelCount = model.labels.length;
	if (labelCount === 0 || new Set(model.labels).size !== labelCount) {
		throw new Error('CRF labels must be non-empty and unique');
	}
	const stateByAttribute = new Map<string, Array<[labelIndex: number, weight: number]>>();
	for (const [attribute, labelIndex, weight] of model.stateFeatures) {
		if (labelIndex < 0 || labelIndex >= labelCount || !Number.isFinite(weight)) {
			throw new Error('Invalid CRF state feature');
		}
		const entries = stateByAttribute.get(attribute) ?? [];
		entries.push([labelIndex, weight]);
		stateByAttribute.set(attribute, entries);
	}
	const transitions = new Float64Array(labelCount * labelCount);
	for (const [fromLabelIndex, toLabelIndex, weight] of model.transitionFeatures) {
		if (
			fromLabelIndex < 0 ||
			fromLabelIndex >= labelCount ||
			toLabelIndex < 0 ||
			toLabelIndex >= labelCount ||
			!Number.isFinite(weight)
		) {
			throw new Error('Invalid CRF transition feature');
		}
		transitions[fromLabelIndex * labelCount + toLabelIndex] = weight;
	}

	return {
		detect(tokens) {
			if (tokens.length === 0) {
				return [];
			}
			const emissions = new Float64Array(tokens.length * labelCount);
			for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
				for (const [attribute, value] of encodeCrfsuiteAttributes(extractCrfFeatures(tokens, tokenIndex, dictionaries))) {
					for (const [labelIndex, weight] of stateByAttribute.get(attribute) ?? []) {
						emissions[tokenIndex * labelCount + labelIndex] += value * weight;
					}
				}
			}

			let previousScores = emissions.slice(0, labelCount);
			let nextScores = new Float64Array(labelCount);
			const backpointers = new Int16Array(tokens.length * labelCount);
			for (let tokenIndex = 1; tokenIndex < tokens.length; tokenIndex++) {
				for (let nextLabel = 0; nextLabel < labelCount; nextLabel++) {
					let bestPrevious = 0;
					let bestScore = previousScores[0] + transitions[nextLabel];
					for (let previousLabel = 1; previousLabel < labelCount; previousLabel++) {
						const score = previousScores[previousLabel] + transitions[previousLabel * labelCount + nextLabel];
						if (score > bestScore) {
							bestScore = score;
							bestPrevious = previousLabel;
						}
					}
					nextScores[nextLabel] = bestScore + emissions[tokenIndex * labelCount + nextLabel];
					backpointers[tokenIndex * labelCount + nextLabel] = bestPrevious;
				}
				const swap = previousScores;
				previousScores = nextScores;
				nextScores = swap;
			}

			let bestLabel = 0;
			for (let labelIndex = 1; labelIndex < labelCount; labelIndex++) {
				if (previousScores[labelIndex] > previousScores[bestLabel]) {
					bestLabel = labelIndex;
				}
			}
			const result = new Array<CheckpointLabel>(tokens.length);
			for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex--) {
				result[tokenIndex] = model.labels[bestLabel];
				bestLabel = backpointers[tokenIndex * labelCount + bestLabel];
			}
			return result;
		},
	};
}

export function reconstructDetectedSpans(labels: readonly string[]): DetectedSpan[] {
	const supportedTypes = new Set<string>(NSW_TYPES);
	const spans: DetectedSpan[] = [];
	let active: DetectedSpan | undefined;
	const close = () => {
		if (active) {
			spans.push(active);
		}
		active = undefined;
	};
	for (let index = 0; index < labels.length; index++) {
		const label = labels[index];
		if (label === 'O' || label === 'B-USS') {
			close();
			continue;
		}
		const match = /^(B|I)-(.+)$/u.exec(label);
		if (!match || !supportedTypes.has(match[2])) {
			close();
			continue;
		}
		const type = match[2] as DetectedSpan['type'];
		if (match[1] === 'B' || active?.type !== type) {
			close();
			active = { type, startToken: index, endToken: index + 1 };
		} else {
			active.endToken = index + 1;
		}
	}
	close();
	return spans;
}
