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

test('multiple rules match different positions in same unit', () => {
	const units = [makeUnit('HTML and CSS')];
	const rules = [
		makeRule('HTML', 'aitch tee em el'),
		makeRule('CSS', 'see ess ess'),
	];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'aitch tee em el and see ess ess');
});
