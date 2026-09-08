import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSsml } from '../../src/offscreen/edge/edge_ssml.ts';

const base = { text: 'Hello', voice: 'en-US-AvaNeural', locale: 'en-US', speed: 1 };

test('wraps the text in a voice and prosody element', () => {
	const ssml = buildSsml(base);
	assert.match(ssml, /<voice name='en-US-AvaNeural'>/u);
	assert.match(ssml, /xml:lang='en-US'/u);
	assert.match(ssml, />Hello</u);
});

test('translates speed to a prosody rate percentage', () => {
	assert.match(buildSsml({ ...base, speed: 1.5 }), /rate='\+50%'/u);
	assert.match(buildSsml({ ...base, speed: 1 }), /rate='\+0%'/u);
	assert.match(buildSsml({ ...base, speed: 0.8 }), /rate='-20%'/u);
});

test('rounds fractional rates to whole percent', () => {
	assert.match(buildSsml({ ...base, speed: 1.125 }), /rate='\+13%'/u);
});

// The readaloud endpoint closes with 1007 on <break>, <bookmark>, <mark>, <s>, <p> and
// <silence>. Measured 2026-09-08; see docs/specs/2026-09-08-edge-tts-stability-design.md.
test('emits no element other than speak, voice and prosody', () => {
	const ssml = buildSsml({ ...base, text: 'Hello there' });
	const elements = [...ssml.matchAll(/<\/?([a-z]+)/gu)].map((match) => match[1]);
	assert.deepEqual([...new Set(elements)].sort(), ['prosody', 'speak', 'voice']);
});

// Guards the behaviour change rather than the signature: bun test does not typecheck, so a
// caller left over from the break era must be ignored at runtime, not merely rejected by tsc.
test('ignores a leftover internalSilenceMs instead of emitting a break', () => {
	const ssml = buildSsml({ ...base, internalSilenceMs: 300 } as Parameters<typeof buildSsml>[0]);
	assert.doesNotMatch(ssml, /<break/u);
});

test('escapes XML metacharacters in the text', () => {
	const ssml = buildSsml({ ...base, text: `Tom & Jerry <b> "x" 'y'` });
	assert.match(ssml, /Tom &amp; Jerry &lt;b&gt; &quot;x&quot; &apos;y&apos;/u);
	assert.doesNotMatch(ssml, /<b>/u);
});
