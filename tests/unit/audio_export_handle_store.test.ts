import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
	clearAudioExportHandles,
	deleteAudioExportHandle,
	putAudioExportHandle,
	takeAudioExportHandle,
} from '../../src/shared/audio_export_handle_store.ts';

const DATABASE_NAME = 'readit-audio-export';
const STORE_NAME = 'handles';

function readStoredRecord(factory: IDBFactory, jobId: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const openRequest = factory.open(DATABASE_NAME);
		openRequest.onerror = () => reject(openRequest.error);
		openRequest.onsuccess = () => {
			const database = openRequest.result;
			const transaction = database.transaction(STORE_NAME, 'readonly');
			const request = transaction.objectStore(STORE_NAME).get(jobId);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result);
			transaction.oncomplete = () => database.close();
		};
	});
}

function rejectedOpenFactory(event: 'error' | 'blocked'): IDBFactory {
	return {
		open: () => {
			const request = {} as IDBOpenDBRequest;
			queueMicrotask(() => request[`on${event}`]?.call(request, new Event(event)));
			return request;
		},
	} as IDBFactory;
}

function blockedThenSuccessfulOpenFactory(): { factory: IDBFactory; lateSuccess: Promise<void>; closeCalls: () => number } {
	let resolveLateSuccess: () => void;
	const lateSuccess = new Promise<void>((resolve) => {
		resolveLateSuccess = resolve;
	});
	let closed = 0;
	const database = { close: () => closed++ } as IDBDatabase;
	const factory = {
		open: () => {
			const request = {} as IDBOpenDBRequest;
			queueMicrotask(() => {
				request.onblocked?.call(request, new Event('blocked'));
				queueMicrotask(() => {
					(request as unknown as { result: IDBDatabase }).result = database;
					request.onsuccess?.call(request, new Event('success'));
					resolveLateSuccess();
				});
			});
			return request;
		},
	} as IDBFactory;
	return { factory, lateSuccess, closeCalls: () => closed };
}

test('consumes a handle exactly once', async () => {
	const factory = new IDBFactory();
	const handle = { name: 'article.mp3' } as FileSystemFileHandle;

	await putAudioExportHandle('job-1', handle, factory);
	assert.deepEqual(await takeAudioExportHandle('job-1', factory), handle);
	assert.equal(await takeAudioExportHandle('job-1', factory), null);
});

test('replaces a handle for the same job', async () => {
	const factory = new IDBFactory();
	const first = { name: 'first.mp3' } as FileSystemFileHandle;
	const replacement = { name: 'replacement.mp3' } as FileSystemFileHandle;

	await putAudioExportHandle('job-1', first, factory);
	await putAudioExportHandle('job-1', replacement, factory);

	assert.deepEqual(await takeAudioExportHandle('job-1', factory), replacement);
});

test('stores only the job ID and handle', async () => {
	const factory = new IDBFactory();
	const handle = { name: 'article.mp3' } as FileSystemFileHandle;

	await putAudioExportHandle('job-1', handle, factory);
	assert.deepEqual(await readStoredRecord(factory, 'job-1'), { jobId: 'job-1', handle });
});

test('deletes a missing handle without error', async () => {
	await deleteAudioExportHandle('missing', new IDBFactory());
});

test('clears abandoned handles without storing job content', async () => {
	const factory = new IDBFactory();
	await putAudioExportHandle('job-1', { name: 'one.mp3' } as FileSystemFileHandle, factory);
	await clearAudioExportHandles(factory);
	assert.equal(await takeAudioExportHandle('job-1', factory), null);
});

test('rejects a transaction that cannot store the handle', async () => {
	const handle = { name: 'article.mp3', unsupported: () => undefined } as FileSystemFileHandle;
	await assert.rejects(putAudioExportHandle('job-1', handle, new IDBFactory()));
});

test('rejects database open errors', async () => {
	await assert.rejects(putAudioExportHandle('job-1', { name: 'article.mp3' } as FileSystemFileHandle, rejectedOpenFactory('error')));
});

test('rejects blocked database opens', async () => {
	await assert.rejects(putAudioExportHandle('job-1', { name: 'article.mp3' } as FileSystemFileHandle, rejectedOpenFactory('blocked')));
});

test('closes a database that succeeds after a blocked open', async () => {
	const { factory, lateSuccess, closeCalls } = blockedThenSuccessfulOpenFactory();

	await assert.rejects(putAudioExportHandle('job-1', { name: 'article.mp3' } as FileSystemFileHandle, factory));
	await lateSuccess;

	assert.equal(closeCalls(), 1);
});
