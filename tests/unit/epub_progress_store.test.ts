import { IDBFactory } from 'fake-indexeddb';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
	clearEpubBookHandle,
	type EpubProgressRecord,
	getEpubBookHandle,
	loadEpubProgress,
	matchesSavedFile,
	putEpubBookHandle,
	saveEpubProgress,
} from '../../src/shared/epub_progress_store.ts';

const record: EpubProgressRecord = {
	title: 'Moby Dick',
	chapterIndex: 3,
	charOffset: 1200,
	totalChapters: 40,
	fileSize: 900_000,
	fileLastModified: 1_700_000_000_000,
	updatedAt: 1_700_000_500_000,
};

function installStorageStub(): { values: Record<string, unknown> } {
	const values: Record<string, unknown> = {};
	(globalThis as { chrome?: unknown }).chrome = {
		storage: {
			local: {
				get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key]])),
				set: async (items: Record<string, unknown>) => Object.assign(values, items),
				remove: async (key: string) => {
					delete values[key];
				},
			},
		},
	};
	return { values };
}

test('progress round-trips through chrome.storage.local', async () => {
	installStorageStub();
	await saveEpubProgress(record);
	assert.deepEqual(await loadEpubProgress(), record);
});

test('a missing or malformed progress record reads as null', async () => {
	const storage = installStorageStub();
	assert.equal(await loadEpubProgress(), null);

	storage.values.readit_epub_progress = { title: 'Broken' };
	assert.equal(await loadEpubProgress(), null);
});

test('a file handle round-trips through IndexedDB', async () => {
	const factory = new IDBFactory();
	const handle = { name: 'book.epub' } as unknown as FileSystemFileHandle;
	await putEpubBookHandle({ handle, fileName: 'book.epub', fileSize: 900_000, fileLastModified: 1_700_000_000_000 }, factory);

	const stored = await getEpubBookHandle(factory);
	assert.equal(stored?.fileName, 'book.epub');
	assert.equal(stored?.fileSize, 900_000);
});

test('clearing removes the stored handle', async () => {
	const factory = new IDBFactory();
	const handle = { name: 'book.epub' } as unknown as FileSystemFileHandle;
	await putEpubBookHandle({ handle, fileName: 'book.epub', fileSize: 1, fileLastModified: 2 }, factory);
	await clearEpubBookHandle(factory);
	assert.equal(await getEpubBookHandle(factory), null);
});

test('a changed file is detected by size or mtime', () => {
	assert.equal(matchesSavedFile(record, { size: 900_000, lastModified: 1_700_000_000_000 }), true);
	assert.equal(matchesSavedFile(record, { size: 900_001, lastModified: 1_700_000_000_000 }), false);
	assert.equal(matchesSavedFile(record, { size: 900_000, lastModified: 1_700_000_000_001 }), false);
});
