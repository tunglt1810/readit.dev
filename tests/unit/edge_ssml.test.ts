import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSsml } from '../../src/offscreen/edge/edge_ssml.ts';

const base = { text: 'Hello', voice: 'en-US-AvaNeural', locale: 'en-US', speed: 1, internalSilenceMs: 0 };

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

test('appends a break for internal silence', () => {
	assert.match(buildSsml({ ...base, internalSilenceMs: 300 }), /<break time='300ms'\/>/u);
});

test('omits the break when there is no internal silence', () => {
	assert.doesNotMatch(buildSsml(base), /<break/u);
});

test('escapes XML metacharacters in the text', () => {
	const ssml = buildSsml({ ...base, text: `Tom & Jerry <b> "x" 'y'` });
	assert.match(ssml, /Tom &amp; Jerry &lt;b&gt; &quot;x&quot; &apos;y&apos;/u);
	assert.doesNotMatch(ssml, /<b>/u);
});
