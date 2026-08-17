import { STORAGE_KEYS } from './constants.ts';
import { browserStorage } from './storage.ts';
import { DEFAULT_TRANSLATION_TARGET, isTranslationTarget } from './translation_policy.ts';
import type { TranslationTarget } from './types.ts';

/** Split out from the storage read so the fallback chain can be tested without `chrome`. */
export function pickStoredTranslationTarget(stored: unknown): TranslationTarget {
	return isTranslationTarget(stored) ? stored : DEFAULT_TRANSLATION_TARGET;
}

export async function readTranslationTarget(): Promise<TranslationTarget> {
	const items = await browserStorage.get(STORAGE_KEYS.TRANSLATION_TARGET);
	return pickStoredTranslationTarget(items[STORAGE_KEYS.TRANSLATION_TARGET]);
}

export async function writeTranslationTarget(target: TranslationTarget): Promise<void> {
	await browserStorage.set({ [STORAGE_KEYS.TRANSLATION_TARGET]: target });
}
