import assert from 'node:assert/strict';
import test from 'node:test';
import { type AudioExportDownloadsApi, createAudioExportDownloader } from '../../src/background/firefox_audio_export_download.ts';

function createDownloadsHarness() {
	const listeners = new Set<(delta: { id: number; state?: { current?: string } }) => void>();
	const requests: unknown[] = [];
	const api: AudioExportDownloadsApi = {
		download: async (options) => {
			requests.push(options);
			return 7;
		},
		onChanged: {
			addListener: (listener) => listeners.add(listener),
			removeListener: (listener) => listeners.delete(listener),
		},
	};
	return { api, listeners, requests };
}

test('starts a Save As download and revokes its object URL after completion', async () => {
	const harness = createDownloadsHarness();
	const revoked: string[] = [];
	const downloader = createAudioExportDownloader(harness.api, {
		createObjectURL: () => 'blob:readit-export',
		revokeObjectURL: (url) => revoked.push(url),
	});

	await downloader(new Blob(['mp3']), 'article.mp3');
	assert.deepEqual(harness.requests, [{ url: 'blob:readit-export', filename: 'article.mp3', saveAs: true }]);
	assert.equal(revoked.length, 0);

	for (const listener of harness.listeners) {
		listener({ id: 7, state: { current: 'complete' } });
	}
	assert.deepEqual(revoked, ['blob:readit-export']);
	assert.equal(harness.listeners.size, 0);
});

test('revokes the object URL when the download cannot start', async () => {
	const harness = createDownloadsHarness();
	harness.api.download = async () => {
		throw new Error('downloads permission missing');
	};
	const revoked: string[] = [];
	const downloader = createAudioExportDownloader(harness.api, {
		createObjectURL: () => 'blob:failed-export',
		revokeObjectURL: (url) => revoked.push(url),
	});

	await assert.rejects(downloader(new Blob(['mp3']), 'article.mp3'), /permission missing/);
	assert.deepEqual(revoked, ['blob:failed-export']);
});
