import { createAudioExportEstimate } from '../shared/audio_export.ts';
import type { AudioExportEstimate } from '../shared/types.ts';
import type { SpeechUnit } from './speech_unit.ts';

const WORDS_PER_MINUTE = 160;
const HAN_CHARACTERS_PER_MINUTE = 240;

function isChineseLanguage(language: string): boolean {
	return language.trim().toLowerCase().startsWith('zh');
}

function spokenCount(text: string, language: string): number {
	if (isChineseLanguage(language)) {
		return text.match(/\p{Script=Han}/gu)?.length ?? 0;
	}
	return text.trim().split(/\s+/u).filter(Boolean).length;
}

export function estimateSpeechUnitDurations(units: readonly SpeechUnit[], language: string, speed: number): readonly number[] {
	const rate = isChineseLanguage(language) ? HAN_CHARACTERS_PER_MINUTE : WORDS_PER_MINUTE;
	return units.map((unit) => (spokenCount(unit.text, language) * 60) / rate / speed + (unit.pauseAfterMs ?? 0) / 1_000);
}

export function estimateSpeechUnits(units: readonly SpeechUnit[], language: string, speed: number): AudioExportEstimate {
	const durationSeconds = estimateSpeechUnitDurations(units, language, speed).reduce((total, duration) => total + duration, 0);
	return createAudioExportEstimate(durationSeconds);
}
