export interface SpeechUnitWordMapEntry {
	text: string;
	start: number;
	end: number;
}

export interface SpeechUnit {
	/** Canonical planned text used for source order, highlights, mappings, and export metadata. */
	text: string;
	/** Internal TTS-only rendering used when absorbed boundaries need cadence preservation. */
	synthesisText?: string;
	/** Internal immutable-export diagnostic index; canonical text and metadata remain unchanged. */
	synthesisIndex?: number;
	pauseAfterMs: number | null;
	wordMap?: readonly SpeechUnitWordMapEntry[];
}
