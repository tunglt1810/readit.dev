import { VOICE_STYLES } from './constants.ts';
import type { TtsProviderId } from './edge_voice_preferences.ts';
import { voicesForLanguage } from './edge_voices.ts';
import { uiLang, VOICE_STYLE_TRANSLATIONS } from './i18n.ts';

export interface VoiceOption {
	id: string;
	name: string;
}

export interface VoiceOptions {
	/** Whether the cloud engine will actually speak, which decides where the choice is stored. */
	usingEdge: boolean;
	options: VoiceOption[];
}

/**
 * The voices to offer for a provider and a language, and which engine they belong to.
 *
 * Choosing edge-tts is not enough on its own: Microsoft has no voices for some languages, and the
 * session quietly runs on-device instead. Offering cloud voices there would name a voice the
 * reader will never hear — which is the shape of the bug this function exists to prevent, where
 * the reader surface listed on-device voices while edge-tts was speaking.
 *
 * The two engines also store a choice differently — edge keys it by language, on-device keys it
 * globally — so callers need `usingEdge` to know which one to write.
 */
export function voiceOptionsFor(provider: TtsProviderId, contentLang: string): VoiceOptions {
	const edgeVoices = voicesForLanguage(contentLang);
	if (provider !== 'edge' || edgeVoices.length === 0) {
		return {
			usingEdge: false,
			options: VOICE_STYLES.map((voice) => ({
				id: voice.id,
				name: `${voice.gender === 'male' ? '♂️' : '♀️'} ${VOICE_STYLE_TRANSLATIONS[uiLang][voice.id as keyof typeof VOICE_STYLE_TRANSLATIONS.en]}`,
			})),
		};
	}
	return {
		usingEdge: true,
		options: edgeVoices.map((voice) => ({
			id: voice.shortName,
			name: `${voice.gender === 'male' ? '♂️' : '♀️'} ${voice.friendlyName}`,
		})),
	};
}
