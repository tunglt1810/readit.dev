type QueuedSynthesis<Input, Output> = {
	input: Input;
	resolve: (output: Output) => void;
	reject: (error: unknown) => void;
};

export class SynthesisArbiter<Input, Output> {
	private readonly foregroundQueue: QueuedSynthesis<Input, Output>[] = [];
	private readonly backgroundQueue: QueuedSynthesis<Input, Output>[] = [];
	private readonly run: (input: Input) => Promise<Output>;
	private running = false;

	constructor(run: (input: Input) => Promise<Output>) {
		this.run = run;
	}

	foreground(input: Input): Promise<Output> {
		return this.enqueue(this.foregroundQueue, input);
	}

	background(input: Input): Promise<Output> {
		return this.enqueue(this.backgroundQueue, input);
	}

	private enqueue(queue: QueuedSynthesis<Input, Output>[], input: Input): Promise<Output> {
		const result = new Promise<Output>((resolve, reject) => {
			queue.push({ input, resolve, reject });
		});
		void this.drain();
		return result;
	}

	private async drain(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		try {
			while (true) {
				const next = this.foregroundQueue.shift() ?? this.backgroundQueue.shift();
				if (!next) {
					return;
				}
				try {
					next.resolve(await this.run(next.input));
				} catch (error) {
					next.reject(error);
				}
			}
		} finally {
			this.running = false;
			if (this.foregroundQueue.length > 0 || this.backgroundQueue.length > 0) {
				void this.drain();
			}
		}
	}
}
