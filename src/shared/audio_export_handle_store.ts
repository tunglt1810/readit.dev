const DATABASE_NAME = 'readit-audio-export';
const DATABASE_VERSION = 1;
const STORE_NAME = 'handles';

type AudioExportHandleRecord = {
	jobId: string;
	handle: FileSystemFileHandle;
};

function toError(value: unknown, fallback: string): Error {
	return value instanceof Error ? value : new Error(fallback);
}

function getFactory(factory?: IDBFactory): IDBFactory {
	if (factory) {
		return factory;
	}
	if (!globalThis.indexedDB) {
		throw new Error('IndexedDB is unavailable');
	}
	return globalThis.indexedDB;
}

function openDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const rejectOpen = (error: Error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
		};
		let request: IDBOpenDBRequest;
		try {
			request = getFactory(factory).open(DATABASE_NAME, DATABASE_VERSION);
		} catch (error) {
			rejectOpen(toError(error, 'Unable to open audio export handle database'));
			return;
		}
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME, { keyPath: 'jobId' });
			}
		};
		request.onerror = () => rejectOpen(toError(request.error, 'Unable to open audio export handle database'));
		request.onblocked = () => rejectOpen(new Error('Audio export handle database is blocked'));
		request.onsuccess = () => {
			const database = request.result;
			if (settled) {
				database.close();
				return;
			}
			settled = true;
			resolve(database);
		};
	});
}

function runTransaction<Result>(
	database: IDBDatabase,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore, setResult: (result: Result) => void, reject: (error: Error) => void) => void,
): Promise<Result> {
	return new Promise((resolve, reject) => {
		let transaction: IDBTransaction;
		try {
			transaction = database.transaction(STORE_NAME, mode);
		} catch (error) {
			reject(toError(error, 'Unable to start audio export handle transaction'));
			return;
		}

		let result: Result;
		let rejected = false;
		const rejectTransaction = (error: Error) => {
			if (!rejected) {
				rejected = true;
				reject(error);
			}
		};
		transaction.onerror = () => rejectTransaction(toError(transaction.error, 'Audio export handle transaction failed'));
		transaction.onabort = () => rejectTransaction(toError(transaction.error, 'Audio export handle transaction aborted'));
		transaction.oncomplete = () => resolve(result);

		try {
			operation(transaction.objectStore(STORE_NAME), (value) => {
				result = value;
			}, rejectTransaction);
		} catch (error) {
			try {
				transaction.abort();
			} catch {
				// The transaction may already be finished.
			}
			rejectTransaction(toError(error, 'Audio export handle transaction failed'));
		}
	});
}

async function withDatabase<Result>(factory: IDBFactory | undefined, operation: (database: IDBDatabase) => Promise<Result>): Promise<Result> {
	const database = await openDatabase(factory);
	try {
		return await operation(database);
	} finally {
		database.close();
	}
}

function rejectOnRequestError(request: IDBRequest, reject: (error: Error) => void): void {
	request.onerror = () => reject(toError(request.error, 'Audio export handle request failed'));
}

function isAudioExportHandleRecord(value: unknown, jobId: string): value is AudioExportHandleRecord {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === 2 && record.jobId === jobId && Object.hasOwn(record, 'handle');
}

export async function putAudioExportHandle(jobId: string, handle: FileSystemFileHandle, factory?: IDBFactory): Promise<void> {
	await withDatabase(factory, (database) =>
		runTransaction<void>(database, 'readwrite', (store, _setResult, reject) => {
			const request = store.put({ jobId, handle } satisfies AudioExportHandleRecord);
			rejectOnRequestError(request, reject);
		}),
	);
}

export async function takeAudioExportHandle(jobId: string, factory?: IDBFactory): Promise<FileSystemFileHandle | null> {
	return withDatabase(factory, (database) =>
		runTransaction<FileSystemFileHandle | null>(database, 'readwrite', (store, setResult, reject) => {
			const getRequest = store.get(jobId);
			rejectOnRequestError(getRequest, reject);
			getRequest.onsuccess = () => {
				const record = getRequest.result;
				setResult(isAudioExportHandleRecord(record, jobId) ? record.handle : null);
				const deleteRequest = store.delete(jobId);
				rejectOnRequestError(deleteRequest, reject);
			};
		}),
	);
}

export async function deleteAudioExportHandle(jobId: string, factory?: IDBFactory): Promise<void> {
	await withDatabase(factory, (database) =>
		runTransaction<void>(database, 'readwrite', (store, _setResult, reject) => {
			const request = store.delete(jobId);
			rejectOnRequestError(request, reject);
		}),
	);
}

export async function clearAudioExportHandles(factory?: IDBFactory): Promise<void> {
	await withDatabase(factory, (database) =>
		runTransaction<void>(database, 'readwrite', (store, _setResult, reject) => {
			const request = store.clear();
			rejectOnRequestError(request, reject);
		}),
	);
}
