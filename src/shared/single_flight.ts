export function createSingleFlight<T>(factory: () => Promise<T>): () => Promise<T> {
	let inFlight: Promise<T> | null = null;

	return () => {
		if (inFlight) {
			return inFlight;
		}

		const current = Promise.resolve().then(factory);
		let tracked: Promise<T>;
		tracked = current.finally(() => {
			if (inFlight === tracked) {
				inFlight = null;
			}
		});
		inFlight = tracked;
		return tracked;
	};
}
