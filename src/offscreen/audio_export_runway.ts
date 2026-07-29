import type { PlaybackStatus } from '../shared/types.ts';

export interface PlaybackRunway {
	active: boolean;
	status: PlaybackStatus;
	currentRemainingSeconds: number;
	nextBufferSeconds: number | null;
	recentSynthesisMilliseconds: readonly number[];
}

export function canStartBackgroundSynthesis(runway: PlaybackRunway): boolean {
	if (!runway.active) {
		return true;
	}
	if (runway.status !== 'playing' || runway.nextBufferSeconds === null) {
		return false;
	}
	const synthesisMilliseconds = Math.max(0, ...runway.recentSynthesisMilliseconds.slice(-5));
	return runway.currentRemainingSeconds + runway.nextBufferSeconds > (synthesisMilliseconds + 250) / 1_000;
}
