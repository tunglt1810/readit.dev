export interface RectBounds {
	top: number;
	height: number;
}

export interface ScrollCalculationResult {
	shouldScroll: boolean;
	deltaY: number;
}

const DEFAULT_TOP_THRESHOLD = 0.2;
const DEFAULT_BOTTOM_THRESHOLD = 0.8;

export function calculateCenteredScrollOffset(
	rect: RectBounds,
	viewportHeight: number,
	topThresholdFraction = DEFAULT_TOP_THRESHOLD,
	bottomThresholdFraction = DEFAULT_BOTTOM_THRESHOLD,
): ScrollCalculationResult {
	const center = rect.top + rect.height / 2;
	const topBound = viewportHeight * topThresholdFraction;
	const bottomBound = viewportHeight * bottomThresholdFraction;

	if (center >= topBound && center <= bottomBound) {
		return { shouldScroll: false, deltaY: 0 };
	}

	const targetCenter = viewportHeight / 2;
	const deltaY = center - targetCenter;
	return { shouldScroll: true, deltaY };
}

export class UserScrollPauseManager {
	private pauseDurationMs: number;
	private getTime: () => number;
	private isPlaying = false;
	private pausedUntil = 0;

	constructor(pauseDurationMs = 3000, getTimeFn: () => number = () => Date.now()) {
		this.pauseDurationMs = pauseDurationMs;
		this.getTime = getTimeFn;
	}

	public setPlaybackState(isPlaying: boolean): void {
		this.isPlaying = isPlaying;
		if (!isPlaying) {
			this.pausedUntil = 0;
		}
	}

	public onUserInteraction(): void {
		if (!this.isPlaying) {
			return;
		}
		this.pausedUntil = this.getTime() + this.pauseDurationMs;
	}

	public isPaused(): boolean {
		if (!this.isPlaying) {
			return false;
		}
		return this.getTime() < this.pausedUntil;
	}
}

export function performCenteredScroll(
	rect: RectBounds,
	viewportHeight: number,
	pauseManager?: UserScrollPauseManager,
	scrollFn: (options: { top: number; behavior: ScrollBehavior }) => void = (opts) => window.scrollBy(opts),
	prefersReducedMotion = false,
): boolean {
	if (pauseManager?.isPaused()) {
		return false;
	}

	const calc = calculateCenteredScrollOffset(rect, viewportHeight);
	if (!calc.shouldScroll) {
		return false;
	}

	const behavior: ScrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';
	scrollFn({ top: calc.deltaY, behavior });
	return true;
}
