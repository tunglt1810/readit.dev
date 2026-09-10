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

const JAPANESE = '日本語のテキストはひらがなとカタカナと漢字を混ぜて書かれています。とても読みやすいです。';
const RUSSIAN = 'Искусственный интеллект меняет способ получения знаний людьми каждый день.';
const PERSIAN = 'هوش مصنوعی روش دسترسی مردم به دانش را تغییر می‌دهد و ابزارهای تازه‌ای می‌سازد.';
const UKRAINIAN = 'Штучний інтелект змінює спосіб, у який люди отримують знання щодня.';

test('replaces a declared locale whose script the text contradicts', () => {
	// A Japanese newspaper served under an English locale: the declaration is about the site chrome.
	assert.equal(detectContentLanguage(JAPANESE, 'en'), 'ja');
	assert.equal(detectContentLanguage(RUSSIAN, 'na'), 'ru');
});

test('keeps a declared locale that agrees with the observed script', () => {
	// Persian and Arabic share a script; overriding would swap a correct declaration for a wrong one.
	assert.equal(detectContentLanguage(PERSIAN, 'fa'), 'fa');
	assert.equal(detectContentLanguage(UKRAINIAN, 'uk'), 'uk');
});

test('leaves Latin-script text to the declared locale', () => {
	// Latin cannot separate en/fr/de, so the script layer must not answer for them at all.
	assert.equal(detectContentLanguage(ENGLISH, 'na'), 'na');
	assert.equal(detectContentLanguage(FRENCH, 'na'), 'na');
	assert.equal(detectContentLanguage(`${ENGLISH} The author is 王小明.`, 'en'), 'en');
});

test('the Vietnamese layer still runs before the script layer', () => {
	assert.equal(detectContentLanguage(VIETNAMESE, 'ru'), 'vi');
});
