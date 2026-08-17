import assert from 'node:assert/strict';
import test from 'node:test';
import { isTranslationAvailable } from '../../src/shared/translation_availability.ts';

type Globals = { Translator?: unknown; LanguageDetector?: unknown };

/** Runs `body` with the two built-in AI globals set as given, then puts the environment back. */
async function withGlobals(globals: Globals, body: () => Promise<void>): Promise<void> {
	const target = globalThis as Globals;
	const hadTranslator = 'Translator' in target;
	const hadDetector = 'LanguageDetector' in target;
	const previousTranslator = target.Translator;
	const previousDetector = target.LanguageDetector;
	if ('Translator' in globals) {
		target.Translator = globals.Translator;
	} else {
		delete target.Translator;
	}
	if ('LanguageDetector' in globals) {
		target.LanguageDetector = globals.LanguageDetector;
	} else {
		delete target.LanguageDetector;
	}
	try {
		await body();
	} finally {
		if (hadTranslator) {
			target.Translator = previousTranslator;
		} else {
			delete target.Translator;
		}
		if (hadDetector) {
			target.LanguageDetector = previousDetector;
		} else {
			delete target.LanguageDetector;
		}
	}
}

const detectorSaying = (availability: string) => ({ availability: () => Promise.resolve(availability) });

// Firefox is the reason this case matters: it ships neither interface, so the button and the target
// language control have to disappear rather than fail when pressed.
test('a browser without the built-in AI interfaces cannot translate', async () => {
	await withGlobals({}, async () => {
		assert.equal(await isTranslationAvailable(), false);
	});
});

test('a Translator without a Language Detector cannot translate', async () => {
	await withGlobals({ Translator: {} }, async () => {
		assert.equal(await isTranslationAvailable(), false);
	});
});

test('interfaces present but no models behind them cannot translate', async () => {
	await withGlobals({ Translator: {}, LanguageDetector: detectorSaying('unavailable') }, async () => {
		assert.equal(await isTranslationAvailable(), false);
	});
});

test('a detector that throws cannot translate', async () => {
	await withGlobals({ Translator: {}, LanguageDetector: { availability: () => Promise.reject(new Error('nope')) } }, async () => {
		assert.equal(await isTranslationAvailable(), false);
	});
});

test('a downloadable model counts as available, because the download happens on first use', async () => {
	await withGlobals({ Translator: {}, LanguageDetector: detectorSaying('downloadable') }, async () => {
		assert.equal(await isTranslationAvailable(), true);
	});
});

test('a ready model counts as available', async () => {
	await withGlobals({ Translator: {}, LanguageDetector: detectorSaying('available') }, async () => {
		assert.equal(await isTranslationAvailable(), true);
	});
});
