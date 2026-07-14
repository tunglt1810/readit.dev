export interface SynthesisKey {
	session: number;
	unitIndex: number;
	speedVersion: number;
}

function identity(key: SynthesisKey): string {
	return `${key.session}:${key.unitIndex}:${key.speedVersion}`;
}

interface SynthesisLease {
	active: boolean;
}

interface SynthesisEntry<Output> {
	key: SynthesisKey;
	lease: SynthesisLease;
	promise: Promise<Output>;
	prefetched: boolean;
}

export class IndexedSynthesisCoordinator<Input, Output> {
	private readonly entries = new Map<string, SynthesisEntry<Output>>();
	private readonly leases = new Map<string, SynthesisLease>();
	private readonly synthesize: (input: Input) => Promise<Output>;

	constructor(synthesize: (input: Input) => Promise<Output>) {
		this.synthesize = synthesize;
	}

	prefetch(key: SynthesisKey, input: Input): void {
		const id = identity(key);
		if (this.entries.has(id)) {
			return;
		}
		const entry = this.createEntry(key, input, true);
		void entry.promise.catch(() => undefined);
	}

	async get(key: SynthesisKey, input: Input): Promise<Output> {
		const id = identity(key);
		const existing = this.entries.get(id);
		if (!existing) {
			return await this.createEntry(key, input, false).promise;
		}
		try {
			return await existing.promise;
		} catch (error) {
			if (!existing.prefetched) {
				throw error;
			}
			if (!existing.lease.active) {
				throw error;
			}
			const current = this.entries.get(id);
			if (current && current !== existing) {
				return await current.promise;
			}
			return await this.createEntry(key, input, false).promise;
		}
	}

	has(key: SynthesisKey): boolean {
		return this.entries.has(identity(key));
	}

	retain(keys: readonly SynthesisKey[]): void {
		const retained = new Set(keys.map(identity));
		for (const [id, lease] of this.leases) {
			if (!retained.has(id)) {
				lease.active = false;
				this.leases.delete(id);
				this.entries.delete(id);
			}
		}
	}

	clear(): void {
		for (const lease of this.leases.values()) {
			lease.active = false;
		}
		this.leases.clear();
		this.entries.clear();
	}

	private createEntry(key: SynthesisKey, input: Input, prefetched: boolean): SynthesisEntry<Output> {
		const id = identity(key);
		let lease = this.leases.get(id);
		if (!lease) {
			lease = { active: true };
			this.leases.set(id, lease);
		}
		const entry: SynthesisEntry<Output> = {
			key,
			lease,
			promise: this.synthesize(input),
			prefetched,
		};
		this.entries.set(id, entry);
		void entry.promise.catch(() => {
			if (this.entries.get(id) === entry) {
				this.entries.delete(id);
			}
		});
		return entry;
	}
}
