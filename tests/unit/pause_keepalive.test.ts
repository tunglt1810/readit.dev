import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createPauseKeepalive,
	PAUSE_KEEPALIVE_FREQUENCY_HZ,
	PAUSE_KEEPALIVE_GAIN,
	PAUSE_KEEPALIVE_INTERVAL_MS,
	PAUSE_KEEPALIVE_PULSE_MS,
	PAUSE_KEEPALIVE_RETRY_MS,
	type PauseKeepaliveAudioContext,
	type PauseKeepaliveScheduler,
} from '../../src/offscreen/pause_keepalive.ts';

type ScheduledTask = {
	handle: number;
	atMs: number;
	callback: () => void;
};

type FakeNode = {
	connections: unknown[];
	disconnectCalls: number;
	disconnect(): void;
};

type FakeAudioContext = {
	context: PauseKeepaliveAudioContext;
	oscillator: FakeNode & {
		type: OscillatorType;
		frequency: { value: number };
		onended: (() => void) | null;
		startCalls: number;
		stopCalls: number;
		stopAtSeconds: number | null;
		start(): void;
		stop(when?: number): void;
		finish(): void;
	};
	gain: FakeNode & { gain: { value: number } };
	resumeCalls: () => number;
	closeCalls: () => number;
	holdClose(): () => void;
	releaseResume(): void;
};

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) {
		await Promise.resolve();
	}
}

function createScheduler(): {
	scheduler: PauseKeepaliveScheduler;
	advanceBy(delayMs: number): Promise<void>;
	pendingCount(): number;
	nextDelayMs(): number;
} {
	let nowMs = 0;
	let nextHandle = 1;
	const tasks = new Map<number, ScheduledTask>();

	const scheduler: PauseKeepaliveScheduler = {
		setTimeout(callback, delayMs) {
			const handle = nextHandle++;
			tasks.set(handle, { handle, atMs: nowMs + delayMs, callback });
			return handle;
		},
		clearTimeout(handle) {
			tasks.delete(handle);
		},
	};

	async function advanceBy(delayMs: number): Promise<void> {
		const targetMs = nowMs + delayMs;
		while (true) {
			const next = [...tasks.values()]
				.filter((task) => task.atMs <= targetMs)
				.sort((left, right) => left.atMs - right.atMs || left.handle - right.handle)[0];
			if (!next) {
				break;
			}
			nowMs = next.atMs;
			tasks.delete(next.handle);
			next.callback();
			await flushMicrotasks();
		}
		nowMs = targetMs;
	}

	return {
		scheduler,
		advanceBy,
		pendingCount: () => tasks.size,
		nextDelayMs: () => Math.min(...[...tasks.values()].map((task) => task.atMs - nowMs)),
	};
}

function createAudioContext(shouldFailResume = false, shouldHoldResume = false): FakeAudioContext {
	let resumeCalls = 0;
	let closeCalls = 0;
	let closePromise: Promise<void> | null = null;
	let releaseClose: (() => void) | null = null;
	let releaseResume: (() => void) | null = null;
	const resumePromise = shouldHoldResume
		? new Promise<void>((resolve) => {
				releaseResume = resolve;
			})
		: null;
	const destination = {} as AudioDestinationNode;
	const oscillator = {
		type: 'square' as OscillatorType,
		frequency: { value: 0 },
		onended: null as (() => void) | null,
		connections: [] as unknown[],
		disconnectCalls: 0,
		startCalls: 0,
		stopCalls: 0,
		stopAtSeconds: null as number | null,
		connect(destinationNode: unknown) {
			this.connections.push(destinationNode);
		},
		disconnect() {
			this.disconnectCalls++;
		},
		start() {
			this.startCalls++;
		},
		stop(when?: number) {
			this.stopCalls++;
			if (when !== undefined) {
				this.stopAtSeconds = when;
			}
		},
		finish() {
			this.onended?.();
		},
	};
	const gain = {
		gain: { value: 0 },
		connections: [] as unknown[],
		disconnectCalls: 0,
		connect(destinationNode: unknown) {
			this.connections.push(destinationNode);
		},
		disconnect() {
			this.disconnectCalls++;
		},
	};

	return {
		context: {
			currentTime: 0,
			destination,
			createOscillator: () => oscillator as unknown as OscillatorNode,
			createGain: () => gain as unknown as GainNode,
			resume: async () => {
				resumeCalls++;
				await resumePromise;
				if (shouldFailResume) {
					throw new Error('resume failed');
				}
			},
			close: async () => {
				closeCalls++;
				await closePromise;
			},
		},
		oscillator,
		gain,
		resumeCalls: () => resumeCalls,
		closeCalls: () => closeCalls,
		holdClose: () => {
			closePromise = new Promise<void>((resolve) => {
				releaseClose = resolve;
			});
			return () => releaseClose?.();
		},
		releaseResume: () => releaseResume?.(),
	};
}

function createAudioContextFactory(options: { failResumeAt?: number; holdResumeAt?: number } = {}): {
	create(): PauseKeepaliveAudioContext;
	contextsCreated(): number;
	latest(): FakeAudioContext;
} {
	const created: FakeAudioContext[] = [];
	return {
		create: () => {
			const contextNumber = created.length + 1;
			const fake = createAudioContext(contextNumber === options.failResumeAt, contextNumber === options.holdResumeAt);
			created.push(fake);
			return fake.context;
		},
		contextsCreated: () => created.length,
		latest: () => {
			const fake = created.at(-1);
			assert.ok(fake);
			return fake;
		},
	};
}

test('waits before pulsing and releases every audio resource after one short pulse', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: true,
		pulseActive: false,
	});
	assert.equal(audio.contextsCreated(), 0);

	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS - 1);
	assert.equal(audio.contextsCreated(), 0);

	await clock.advanceBy(1);
	assert.equal(audio.contextsCreated(), 1);
	const fake = audio.latest();
	assert.equal(fake.resumeCalls(), 1);
	assert.equal(fake.oscillator.type, 'sine');
	assert.equal(fake.oscillator.frequency.value, PAUSE_KEEPALIVE_FREQUENCY_HZ);
	assert.equal(fake.gain.gain.value, PAUSE_KEEPALIVE_GAIN);
	assert.deepEqual(fake.oscillator.connections, [fake.gain]);
	assert.deepEqual(fake.gain.connections, [fake.context.destination]);
	assert.equal(fake.oscillator.startCalls, 1);
	assert.equal(fake.oscillator.stopAtSeconds, PAUSE_KEEPALIVE_PULSE_MS / 1000);
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: false,
		pulseActive: true,
	});

	fake.oscillator.finish();
	await flushMicrotasks();

	assert.equal(fake.oscillator.disconnectCalls, 1);
	assert.equal(fake.gain.disconnectCalls, 1);
	assert.equal(fake.closeCalls(), 1);
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: true,
		pulseActive: false,
	});
	assert.equal(clock.nextDelayMs(), PAUSE_KEEPALIVE_INTERVAL_MS);
});

test('repeated start calls arm one timer and create one pulse', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await Promise.all([keepalive.start(), keepalive.start()]);
	assert.equal(clock.pendingCount(), 1);
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: true,
		pulseActive: false,
	});
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	assert.equal(audio.contextsCreated(), 1);
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: false,
		pulseActive: true,
	});
	await keepalive.stop();
});

test('stop during the idle delay cancels the timer without creating a context', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	await keepalive.stop();
	assert.equal(clock.pendingCount(), 0);
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	assert.equal(audio.contextsCreated(), 0);
	assert.deepEqual(keepalive.getDebugState(), {
		running: false,
		timerScheduled: false,
		pulseActive: false,
	});
});

test('stop during a pulse stops and closes it without scheduling another pulse', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	const fake = audio.latest();
	await keepalive.stop();

	assert.equal(fake.oscillator.disconnectCalls, 1);
	assert.equal(fake.gain.disconnectCalls, 1);
	assert.equal(fake.closeCalls(), 1);
	assert.equal(clock.pendingCount(), 0);
	assert.deepEqual(keepalive.getDebugState(), {
		running: false,
		timerScheduled: false,
		pulseActive: false,
	});
});

test('repeated stop calls share one active-pulse teardown', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	const releaseClose = audio.latest().holdClose();
	const firstStop = keepalive.stop();
	const secondStop = keepalive.stop();

	assert.equal(firstStop, secondStop);
	assert.deepEqual(keepalive.getDebugState(), {
		running: false,
		timerScheduled: false,
		pulseActive: true,
	});
	releaseClose();
	await Promise.all([firstStop, secondStop]);
	assert.equal(audio.latest().closeCalls(), 1);
	assert.deepEqual(keepalive.getDebugState(), {
		running: false,
		timerScheduled: false,
		pulseActive: false,
	});
});

test('start during teardown waits before arming a replacement generation', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	const releaseClose = audio.latest().holdClose();
	const stopping = keepalive.stop();
	const restarting = keepalive.start();

	await flushMicrotasks();
	assert.equal(clock.pendingCount(), 0);
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: false,
		pulseActive: true,
	});
	releaseClose();
	await Promise.all([stopping, restarting]);
	assert.equal(clock.pendingCount(), 1);
	assert.equal(clock.nextDelayMs(), PAUSE_KEEPALIVE_INTERVAL_MS);
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: true,
		pulseActive: false,
	});
	await keepalive.stop();
});

test('stop and restart while a pulse is resuming cannot revive the stale generation', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory({ holdResumeAt: 1 });
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	const stale = audio.latest();
	const releaseClose = stale.holdClose();
	const stopping = keepalive.stop();
	const restarting = keepalive.start();

	stale.releaseResume();
	await flushMicrotasks();
	assert.equal(stale.oscillator.startCalls, 0);
	assert.equal(clock.pendingCount(), 0);
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: false,
		pulseActive: true,
	});

	releaseClose();
	await Promise.all([stopping, restarting]);
	assert.equal(stale.closeCalls(), 1);
	assert.equal(clock.pendingCount(), 1);
	assert.equal(clock.nextDelayMs(), PAUSE_KEEPALIVE_INTERVAL_MS);
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: true,
		pulseActive: false,
	});
	await keepalive.stop();
});

test('failed pulse creation cleans partial resources and retries after two seconds', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory({ failResumeAt: 1 });
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	await flushMicrotasks();

	const failed = audio.latest();
	assert.equal(failed.oscillator.disconnectCalls, 1);
	assert.equal(failed.gain.disconnectCalls, 1);
	assert.equal(failed.closeCalls(), 1);
	assert.equal(clock.nextDelayMs(), PAUSE_KEEPALIVE_RETRY_MS);
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: true,
		pulseActive: false,
	});
	await keepalive.stop();
});
