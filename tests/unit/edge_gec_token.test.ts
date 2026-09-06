import assert from 'node:assert/strict';
import test from 'node:test';
import { SEC_MS_GEC_VERSION, secMsGecToken, TRUSTED_CLIENT_TOKEN } from '../../src/offscreen/edge/gec_token.ts';

// 2026-09-06T12:03:47Z — deliberately not on a 5-minute boundary.
const SAMPLE_MS = Date.UTC(2026, 8, 6, 12, 3, 47);

async function expectedFor(ms: number): Promise<string> {
	const ticks = Math.floor((ms / 1000 + 11_644_473_600) * 10_000_000);
	const floored = ticks - (ticks % 3_000_000_000);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${floored}${TRUSTED_CLIENT_TOKEN}`));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase();
}

test('hashes the windows filetime floored to five minutes', async () => {
	assert.equal(await secMsGecToken(SAMPLE_MS), await expectedFor(SAMPLE_MS));
});

test('returns the same token anywhere inside one five-minute window', async () => {
	const early = await secMsGecToken(Date.UTC(2026, 8, 6, 12, 0, 1));
	const late = await secMsGecToken(Date.UTC(2026, 8, 6, 12, 4, 59));
	assert.equal(early, late);
});

test('changes token across a five-minute boundary', async () => {
	const before = await secMsGecToken(Date.UTC(2026, 8, 6, 12, 4, 59));
	const after = await secMsGecToken(Date.UTC(2026, 8, 6, 12, 5, 1));
	assert.notEqual(before, after);
});

test('is uppercase hex of a sha-256 digest', async () => {
	assert.match(await secMsGecToken(SAMPLE_MS), /^[0-9A-F]{64}$/u);
});

test('pins a version at or above the endpoint floor', () => {
	const minor = Number(SEC_MS_GEC_VERSION.split('-')[1].split('.')[0]);
	assert.ok(minor >= 133, `Sec-MS-GEC-Version ${SEC_MS_GEC_VERSION} is below the 1-133 floor`);
});
