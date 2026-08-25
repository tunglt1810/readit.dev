import { expect, test } from './fixtures';

test.use({ freshExtensionWorker: true });

test('registers the PDF.js fake-worker handler in the extension service worker', async ({ context }) => {
	const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
	const runtime = await worker.evaluate(() => {
		const pdfjsWorker = (
			globalThis as typeof globalThis & {
				pdfjsWorker?: { WorkerMessageHandler?: unknown };
			}
		).pdfjsWorker;
		return {
			worker: typeof Worker,
			workerMessageHandler: typeof pdfjsWorker?.WorkerMessageHandler,
		};
	});

	expect(runtime).toEqual({ worker: 'undefined', workerMessageHandler: 'function' });
});
