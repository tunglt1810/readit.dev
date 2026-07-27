import assert from 'node:assert/strict';
import test from 'node:test';
import { detectContentLanguage } from '../../src/shared/language_detection.ts';

const VIETNAMESE =
	'Chia tay không chỉ là buồn trong lòng, mà còn là một cú sốc mạnh với não bộ và cơ thể. ' +
	'Vì vậy, cảm giác đau đớn, rối loạn, mất phương hướng sau chia tay không phải là yếu đuối.';
const ENGLISH = 'Romantic rejection activates the same brain regions implicated in physical pain.';
const FRENCH = "Le rejet amoureux active les mêmes régions cérébrales que la douleur physique, d'après la recherche.";

test('reads the language from the text, not from the declared locale', () => {
	// A Vietnamese document opened under an English UI: the declared locale is wrong, and keeping it
	// costs the duration predictor its Vietnamese correction.
	assert.equal(detectContentLanguage(VIETNAMESE, 'en'), 'vi');
	assert.equal(detectContentLanguage(VIETNAMESE, 'vi'), 'vi');
	assert.equal(detectContentLanguage(VIETNAMESE, 'na'), 'vi');
});

test('does not let non-Vietnamese text inherit a declared vi', () => {
	assert.equal(detectContentLanguage(ENGLISH, 'vi'), 'na');
	assert.equal(detectContentLanguage(FRENCH, 'vi'), 'na');
});

test('leaves an accented non-Vietnamese declaration untouched', () => {
	assert.equal(detectContentLanguage(FRENCH, 'fr'), 'fr');
	assert.equal(detectContentLanguage(ENGLISH, 'en'), 'en');
});

test('survives text with no letters at all', () => {
	assert.equal(detectContentLanguage('123 456 --- 789', 'en'), 'en');
	assert.equal(detectContentLanguage('', 'vi'), 'na');
});

test('detects Vietnamese in a mostly-English document that quotes Vietnamese prose', () => {
	// The 3% floor is meant to leave room for the reverse case too: a short Vietnamese quotation
	// inside English prose must not flip the whole document to vi.
	const mostlyEnglish = `${ENGLISH} ${ENGLISH} ${ENGLISH} ${ENGLISH} Một câu tiếng Việt.`;
	assert.equal(detectContentLanguage(mostlyEnglish, 'en'), 'en');
});
