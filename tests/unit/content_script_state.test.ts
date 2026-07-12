import assert from 'node:assert/strict';
import test from 'node:test';
import { claimContentScriptInitialization } from '../../src/content/content_script_state.ts';

test('claims content-script initialization only once per isolated world', () => {
	const isolatedWorld: Record<string, unknown> = {};

	assert.equal(claimContentScriptInitialization(isolatedWorld), true);
	assert.equal(claimContentScriptInitialization(isolatedWorld), false);
});
