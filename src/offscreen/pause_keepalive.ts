export const PAUSE_KEEPALIVE_FREQUENCY_HZ = 20;
export const PAUSE_KEEPALIVE_GAIN = 0.001;
export const PAUSE_KEEPALIVE_PULSE_MS = 250;
export const PAUSE_KEEPALIVE_INTERVAL_MS = 20_000;
export const PAUSE_KEEPALIVE_RETRY_MS = 2_000;

export interface PauseKeepaliveAudioContext {
	currentTime: number;
	destination: AudioDestinationNode;
	createOscillator(): OscillatorNode;
	createGain(): GainNode;
	resume(): Promise<void>;
	close(): Promise<void>;
}

export interface PauseKeepaliveScheduler {
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(handle: number): void;
}

export type PauseKeepaliveDebugState = {
	running: boolean;
	timerScheduled: boolean;
	pulseActive: boolean;
};

export interface PauseKeepalive {
	start(): Promise<void>;
	stop(): Promise<void>;
	getDebugState(): PauseKeepaliveDebugState;
}

type ActivePulse = {
	context: PauseKeepaliveAudioContext;
	oscillator: OscillatorNode | null;
	gain: GainNode | null;
	cleanup: Promise<void> | null;
};

export function createPauseKeepalive(
	createAudioContext: () => PauseKeepaliveAudioContext,
	scheduler: PauseKeepaliveScheduler,
): PauseKeepalive {
	let running = false;
	let generation = 0;
	let timerHandle: number | null = null;
	let activePulse: ActivePulse | null = null;
	let starting: Promise<void> | null = null;
	let teardown: Promise<void> | null = null;

	function cleanupPulse(pulse: ActivePulse): Promise<void> {
		if (pulse.cleanup) {
			return pulse.cleanup;
		}

		pulse.cleanup = (async () => {
			if (pulse.oscillator) {
				pulse.oscillator.onended = null;
			}
			try {
				pulse.oscillator?.stop();
			} catch (_error) {
				// The oscillator may already have stopped.
			}
			try {
				pulse.oscillator?.disconnect();
			} catch (_error) {
				// The node may already have been disconnected.
			}
			try {
				pulse.gain?.disconnect();
			} catch (_error) {
				// The node may already have been disconnected.
			}
			try {
				await pulse.context.close();
			} catch (_error) {
				// Chrome may already have closed the short-lived context.
			}
			pulse.oscillator = null;
			pulse.gain = null;
		})();

		return pulse.cleanup;
	}

	function schedule(delayMs: number, expectedGeneration: number): void {
		if (!running || generation !== expectedGeneration || timerHandle !== null || activePulse !== null) {
			return;
		}
		timerHandle = scheduler.setTimeout(() => {
			timerHandle = null;
			void runPulse(expectedGeneration);
		}, delayMs);
	}

	async function finishPulse(pulse: ActivePulse, expectedGeneration: number, failed: boolean): Promise<void> {
		await cleanupPulse(pulse);
		if (activePulse === pulse) {
			activePulse = null;
		}
		if (running && generation === expectedGeneration) {
			schedule(failed ? PAUSE_KEEPALIVE_RETRY_MS : PAUSE_KEEPALIVE_INTERVAL_MS, expectedGeneration);
		}
	}

	async function runPulse(expectedGeneration: number): Promise<void> {
		if (!running || generation !== expectedGeneration || activePulse !== null) {
			return;
		}

		let pulse: ActivePulse | null = null;
		let finished = false;
		const finishOnce = async (failed: boolean): Promise<void> => {
			if (finished || !pulse) {
				return;
			}
			finished = true;
			await finishPulse(pulse, expectedGeneration, failed);
		};

		try {
			const context = createAudioContext();
			pulse = {
				context,
				oscillator: null,
				gain: null,
				cleanup: null,
			};
			activePulse = pulse;

			const oscillator = context.createOscillator();
			pulse.oscillator = oscillator;
			const gain = context.createGain();
			pulse.gain = gain;
			oscillator.type = 'sine';
			oscillator.frequency.value = PAUSE_KEEPALIVE_FREQUENCY_HZ;
			gain.gain.value = PAUSE_KEEPALIVE_GAIN;
			oscillator.connect(gain);
			gain.connect(context.destination);

			await context.resume();
			if (!running || generation !== expectedGeneration) {
				await finishOnce(false);
				return;
			}

			oscillator.onended = () => {
				void finishOnce(false);
			};
			oscillator.start();
			oscillator.stop(context.currentTime + PAUSE_KEEPALIVE_PULSE_MS / 1000);
		} catch (_error) {
			if (pulse) {
				await finishOnce(true);
			} else if (running && generation === expectedGeneration) {
				schedule(PAUSE_KEEPALIVE_RETRY_MS, expectedGeneration);
			}
		}
	}

	function start(): Promise<void> {
		if (running) {
			return starting ?? Promise.resolve();
		}

		running = true;
		const expectedGeneration = ++generation;
		const begin = teardown ?? Promise.resolve();
		const pendingStart = begin.then(() => {
			if (running && generation === expectedGeneration) {
				schedule(PAUSE_KEEPALIVE_INTERVAL_MS, expectedGeneration);
			}
		});
		const trackedStart = pendingStart.finally(() => {
			if (starting === trackedStart) {
				starting = null;
			}
		});
		starting = trackedStart;
		return trackedStart;
	}

	function stop(): Promise<void> {
		running = false;
		generation++;
		if (timerHandle !== null) {
			scheduler.clearTimeout(timerHandle);
			timerHandle = null;
		}
		if (teardown) {
			return teardown;
		}
		if (!activePulse) {
			return starting ?? Promise.resolve();
		}

		const pulse = activePulse;
		const trackedTeardown = finishPulse(pulse, generation, false).finally(() => {
			if (teardown === trackedTeardown) {
				teardown = null;
			}
		});
		teardown = trackedTeardown;
		return trackedTeardown;
	}

	function getDebugState(): PauseKeepaliveDebugState {
		return {
			running,
			timerScheduled: timerHandle !== null,
			pulseActive: activePulse !== null,
		};
	}

	return { start, stop, getDebugState };
}
