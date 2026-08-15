import { STORAGE_KEYS } from './constants.ts';

const DATABASE_NAME = 'readit-epub-library';
const DATABASE_VERSION = 1;
const STORE_NAME = 'handles';
const CURRENT_BOOK_KEY = 'current-book';

export interface BookProgressRecord {
	title: string;
	chapterIndex: number;
	charOffset: number;
	totalChapters: number;
	/** Length of the text the offset points into. Absent on records written before pages existed. */
	totalChars?: number;
	fileSize: number;
	fileLastModified: number;
	updatedAt: number;
}

export interface BookHandleRecord {
	handle: FileSystemFileHandle;
	fileName: string;
	fileSize: number;
	fileLastModified: number;
}

function isBookProgressRecord(value: unknown): value is BookProgressRecord {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.title === 'string' &&
		Number.isInteger(record.chapterIndex) &&
		Number.isFinite(record.charOffset) &&
		Number.isInteger(record.totalChapters) &&
		(record.totalChars === undefined || Number.isFinite(record.totalChars)) &&
		Number.isFinite(record.fileSize) &&
		Number.isFinite(record.fileLastModified) &&
		Number.isFinite(record.updatedAt)
	);
}

export async function saveBookProgress(record: BookProgressRecord): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEYS.EPUB_PROGRESS]: record });
}

export async function loadBookProgress(): Promise<BookProgressRecord | null> {
	const result = (await chrome.storage.local.get([STORAGE_KEYS.EPUB_PROGRESS])) as Record<string, unknown>;
	const stored = result[STORAGE_KEYS.EPUB_PROGRESS];
	return isBookProgressRecord(stored) ? stored : null;
}

export async function clearBookProgress(): Promise<void> {
	await chrome.storage.local.remove(STORAGE_KEYS.EPUB_PROGRESS);
}

export function matchesSavedFile(record: BookProgressRecord, file: { size: number; lastModified: number }): boolean {
	return record.fileSize === file.size && record.fileLastModified === file.lastModified;
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
		const request = getFactory(factory).open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME);
			}
		};
		request.onerror = () => reject(request.error ?? new Error('Failed to open the book library database'));
		request.onsuccess = () => resolve(request.result);
	});
}

async function withStore<Result>(
	factory: IDBFactory | undefined,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest,
): Promise<Result> {
	const database = await openDatabase(factory);
	try {
		return await new Promise<Result>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, mode);
			const request = operation(transaction.objectStore(STORE_NAME));
			request.onerror = () => reject(request.error ?? new Error('Book library request failed'));
			request.onsuccess = () => resolve(request.result as Result);
		});
	} finally {
		database.close();
	}
}

export async function putBookHandle(record: BookHandleRecord, factory?: IDBFactory): Promise<void> {
	await withStore(factory, 'readwrite', (store) => store.put(record, CURRENT_BOOK_KEY));
}

export async function getBookHandle(factory?: IDBFactory): Promise<BookHandleRecord | null> {
	const stored = await withStore<BookHandleRecord | undefined>(factory, 'readonly', (store) => store.get(CURRENT_BOOK_KEY));
	return stored?.handle ? stored : null;
}

export async function clearBookHandle(factory?: IDBFactory): Promise<void> {
	await withStore(factory, 'readwrite', (store) => store.delete(CURRENT_BOOK_KEY));
}
