import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPronunciationDictionary } from '../../src/offscreen/pronunciation_dictionary.ts';
import type { PronunciationRule } from '../../src/shared/types.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';

function makeUnit(text: string, synthesisText?: string): SpeechUnit {
	return { text, synthesisText, pauseAfterMs: 0 };
}

function makeRule(match: string, replacement: string, overrides?: Partial<PronunciationRule>): PronunciationRule {
	return {
		id: crypto.randomUUID(),
		match,
		replacement,
		wholeWord: true,
		caseSensitive: true,
		enabled: true,
		createdAt: Date.now(),
		...overrides,
	};
}

// --- Cycle 1: Basic exact match ---

test('exact match assigns synthesisText, leaves text unchanged', () => {
	const units = [makeUnit('HTML is great')];
	const rules = [makeRule('HTML', 'aitch tee em el')];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'aitch tee em el is great');
	assert.equal(units[0].text, 'HTML is great');
});

// --- Cycle 2: Whole-word boundary ---

test('wholeWord=true does not match inside another word', () => {
	const units = [makeUnit('the USB controller')];
	const rules = [makeRule('US', 'united states')];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, undefined);
});

test('wholeWord=false matches inside words', () => {
	const units = [makeUnit('the USB controller')];
	const rules = [makeRule('US', 'united states', { wholeWord: false })];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'the united statesB controller');
});

// --- Cycle 3: Case sensitivity ---

test('caseSensitive=true does not match different case', () => {
	const units = [makeUnit('html is great')];
	const rules = [makeRule('HTML', 'aitch tee em el')];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, undefined);
});

test('caseSensitive=false matches regardless of case', () => {
	const units = [makeUnit('html is great')];
	const rules = [makeRule('HTML', 'aitch tee em el', { caseSensitive: false })];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'aitch tee em el is great');
});

// --- Cycle 4: Language filtering ---

test('rule with lang="en" is skipped for Vietnamese units', () => {
	const units = [makeUnit('HTML is great')];
	const rules = [makeRule('HTML', 'aitch tee em el', { lang: 'en' })];
	applyPronunciationDictionary(units, rules, 'vi');
	assert.equal(units[0].synthesisText, undefined);
});

test('rule with lang="en" applies for English units', () => {
	const units = [makeUnit('HTML is great')];
	const rules = [makeRule('HTML', 'aitch tee em el', { lang: 'en' })];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'aitch tee em el is great');
});

test('rule without lang applies to all languages', () => {
	const units = [makeUnit('HTML is great')];
	const rules = [makeRule('HTML', 'aitch tee em el')];
	applyPronunciationDictionary(units, rules, 'vi');
	assert.equal(units[0].synthesisText, 'aitch tee em el is great');
});

// --- Cycle 5: Longest-match-first precedence ---

test('longest match wins when multiple rules match same position', () => {
	const units = [makeUnit('USA is a country')];
	const rules = [
		makeRule('US', 'united states'),
		makeRule('USA', 'united states of america'),
	];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'united states of america is a country');
});

// --- Cycle 6: Enabled filter ---

test('disabled rules are skipped', () => {
	const units = [makeUnit('HTML is great')];
	const rules = [makeRule('HTML', 'aitch tee em el', { enabled: false })];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, undefined);
});

// --- Cycle 7: Existing synthesisText ---

test('applies dictionary on existing synthesisText, not text', () => {
	const units = [makeUnit('original text', 'HTML was normalized')];
	const rules = [makeRule('HTML', 'aitch tee em el')];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'aitch tee em el was normalized');
	assert.equal(units[0].text, 'original text');
});

// --- Cycle 8: Edge cases ---

test('empty rules array does not mutate units', () => {
	const units = [makeUnit('HTML is great')];
	applyPronunciationDictionary(units, [], 'en');
	assert.equal(units[0].synthesisText, undefined);
});

test('empty replacement removes matched text', () => {
	const units = [makeUnit('sponsored HTML content')];
	const rules = [makeRule('sponsored', '', { wholeWord: true })];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, ' HTML content');
});

// --- Cycle 9: Whole-word boundaries hold at every match, not just the first ---

test('wholeWord=true leaves later matches inside words alone', () => {
	const units = [makeUnit('AI is the topic, and OpenAI is not.')];
	applyPronunciationDictionary(units, [makeRule('AI', 'ÂY AI')], 'en');
	assert.equal(units[0].synthesisText, 'ÂY AI is the topic, and OpenAI is not.');
});

test('wholeWord=true still applies when the first match is inside a word', () => {
	const units = [makeUnit('OpenAI builds AI.')];
	applyPronunciationDictionary(units, [makeRule('AI', 'ÂY AI')], 'en');
	assert.equal(units[0].synthesisText, 'OpenAI builds ÂY AI.');
});

test('wholeWord=true matches a word wrapped in punctuation', () => {
	const units = [makeUnit('the (AI) report and "AI" too')];
	applyPronunciationDictionary(units, [makeRule('AI', 'ÂY AI')], 'en');
	assert.equal(units[0].synthesisText, 'the (ÂY AI) report and "ÂY AI" too');
});

test('wholeWord=true does not treat a diacritic neighbour as a boundary', () => {
	const units = [makeUnit('người Thái ai cũng biết')];
	applyPronunciationDictionary(units, [makeRule('ai', 'ây ai')], 'vi');
	assert.equal(units[0].synthesisText, 'người Thái ây ai cũng biết');
});

// --- Cycle 10: Rules that would overrun synthesis capacity ---

test('a rule that pushes a unit past synthesis capacity leaves the unit as written', () => {
	// 290 characters, which is inside the 300-character limit the unit was planned against.
	const text = `${'AI '.repeat(6)}${'x'.repeat(272)}`;
	assert.equal(text.length, 290);
	const units = [makeUnit(text)];
	applyPronunciationDictionary(units, [makeRule('AI', 'ÂY AI')], 'vi');
	// Six replacements add 18 characters, so applying them would make the unit unsynthesizable.
	assert.equal(units[0].synthesisText, undefined);
	assert.equal(units[0].text, text);
});

test('a rule still applies when the lengthened unit stays within capacity', () => {
	const text = `${'AI '.repeat(6)}${'x'.repeat(250)}`;
	const units = [makeUnit(text)];
	applyPronunciationDictionary(units, [makeRule('AI', 'ÂY AI')], 'vi');
	assert.equal(units[0].synthesisText, `${'ÂY AI '.repeat(6)}${'x'.repeat(250)}`);
});

test('multiple rules match different positions in same unit', () => {
	const units = [makeUnit('HTML and CSS')];
	const rules = [
		makeRule('HTML', 'aitch tee em el'),
		makeRule('CSS', 'see ess ess'),
	];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'aitch tee em el and see ess ess');
});
