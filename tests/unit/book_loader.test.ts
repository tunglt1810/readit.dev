import assert from 'node:assert/strict';
import test from 'node:test';
import { detectBookKind, ensureReadPermission } from '../../src/reader/book_loader.ts';

test('detects book kinds from the file extension, case-insensitively', () => {
	assert.equal(detectBookKind('novel.epub'), 'epub');
	assert.equal(detectBookKind('NOVEL.EPUB'), 'epub');
	assert.equal(detectBookKind('report.pdf'), 'pdf');
	assert.equal(detectBookKind('report.PDF'), 'pdf');
});

test('rejects unsupported and extensionless files', () => {
	assert.equal(detectBookKind('notes.txt'), null);
	assert.equal(detectBookKind('archive.epub.zip'), null);
	assert.equal(detectBookKind('README'), null);
});

function permissionHandle(query: PermissionState, request?: PermissionState): FileSystemFileHandle {
	return {
		queryPermission: async () => query,
		requestPermission: async () => request ?? query,
	} as unknown as FileSystemFileHandle;
}

test('an already-granted handle needs no prompt', async () => {
	assert.equal(await ensureReadPermission(permissionHandle('granted')), true);
});

test('a promptable handle is granted after requesting', async () => {
	assert.equal(await ensureReadPermission(permissionHandle('prompt', 'granted')), true);
});

test('a denied request reports failure', async () => {
	assert.equal(await ensureReadPermission(permissionHandle('prompt', 'denied')), false);
});

test('a handle without the permission API is treated as unavailable', async () => {
	assert.equal(await ensureReadPermission({} as FileSystemFileHandle), false);
});
