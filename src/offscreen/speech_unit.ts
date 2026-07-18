export interface SpeechUnitWordMapEntry {
	text: string;
	start: number;
	end: number;
}

export interface SpeechUnit {
	text: string;
	pauseAfterMs: number | null;
	wordMap?: readonly SpeechUnitWordMapEntry[];
}
