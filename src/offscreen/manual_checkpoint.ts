export type ManualCheckpoint = {
	sessionId: string;
	panelInstanceId: string;
	unitIndex: number;
	sourceOffsetSec: number;
	wordIndex: number;
	bufferDurationSec: number;
};

export function resumeOffsetSeconds(input: { bufferDurationSec: number; elapsedSec: number }): number {
	return Math.min(Math.max(input.elapsedSec, 0), input.bufferDurationSec);
}

export function isCheckpointOwner(checkpoint: ManualCheckpoint | null, panelInstanceId: string): boolean {
	return checkpoint?.panelInstanceId === panelInstanceId;
}

export function captureManualCheckpoint(input: {
	sessionId: string;
	panelInstanceId: string;
	unitIndex: number;
	bufferDurationSec: number;
	elapsedSec: number;
	wordIndex: number;
}): ManualCheckpoint {
	return {
		sessionId: input.sessionId,
		panelInstanceId: input.panelInstanceId,
		unitIndex: input.unitIndex,
		sourceOffsetSec: resumeOffsetSeconds(input),
		wordIndex: input.wordIndex,
		bufferDurationSec: input.bufferDurationSec,
	};
}
