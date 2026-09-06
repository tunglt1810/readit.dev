import { STORAGE_KEYS } from './constants.ts';
import { defaultVoiceForLanguage, voiceBelongsToLanguage } from './edge_voices.ts';
import { browserStorage } from './storage.ts';

export type TtsProviderId = 'edge' | 'supertonic';

/** Preferences are keyed by base language so en-GB and en-US share one choice. */
function preferenceKey(lang: string): string {
	return lang.trim().replaceAll('_', '-').toLowerCase().split('-')[0];
}

/**
 * The voice to speak this language with: the stored choice when it still belongs to the language,
 * otherwise the language's default, otherwise null when edge-tts cannot speak it.
 */
export function resolveEdgeVoice(stored: Record<string, string>, lang: string): string | null {
	const preferred = stored[preferenceKey(lang)];
	if (preferred && voiceBelongsToLanguage(preferred, lang)) {
		return preferred;
	}
	return defaultVoiceForLanguage(lang);
}

export async function readTtsProvider(): Promise<TtsProviderId> {
	const stored = await browserStorage.get(STORAGE_KEYS.TTS_PROVIDER);
	return stored[STORAGE_KEYS.TTS_PROVIDER] === 'supertonic' ? 'supertonic' : 'edge';
}

export async function writeTtsProvider(provider: TtsProviderId): Promise<void> {
	await browserStorage.set({ [STORAGE_KEYS.TTS_PROVIDER]: provider });
}

export async function readEdgeVoices(): Promise<Record<string, string>> {
	const stored = await browserStorage.get(STORAGE_KEYS.EDGE_VOICES);
	return (stored[STORAGE_KEYS.EDGE_VOICES] as Record<string, string>) ?? {};
}

export async function readEdgeVoice(lang: string): Promise<string | null> {
	return resolveEdgeVoice(await readEdgeVoices(), lang);
}

export async function writeEdgeVoice(lang: string, voiceId: string): Promise<void> {
	const voices = { ...(await readEdgeVoices()), [preferenceKey(lang)]: voiceId };
	await browserStorage.set({ [STORAGE_KEYS.EDGE_VOICES]: voices });
}
