import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { copyDirectoryTreeSync } from '../e2e/cache_storage_copy.ts';

test('copyDirectoryTreeSync gives the destination independent file contents', () => {
	const root = path.resolve(process.cwd(), '.tmp', 'cache-copy-test');
	const source = path.join(root, 'source');
	const destination = path.join(root, 'destination');
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
	fs.writeFileSync(path.join(source, 'nested', 'model.bin'), 'seed');

	try {
		copyDirectoryTreeSync(source, destination);
		fs.writeFileSync(path.join(destination, 'nested', 'model.bin'), 'test-only mutation');
		assert.equal(fs.readFileSync(path.join(source, 'nested', 'model.bin'), 'utf8'), 'seed');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
