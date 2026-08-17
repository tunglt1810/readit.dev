import assert from 'node:assert/strict';
import test from 'node:test';
import type { TranslationDependencies } from '../../src/background/translate_article.ts';
import { splitParagraphs, translateArticleText } from '../../src/background/translate_article.ts';

function fakeDependencies(options: {
	detected?: { language: string; confidence: number } | null;
	translate?: (input: string) => string;
	onCreate?: () => void;
}): TranslationDependencies {
	return {
		detectLanguage: async () => (options.detected === undefined ? { language: 'en', confidence: 1 } : options.detected),
		createTranslator: async () => {
			options.onCreate?.();
			return { translate: async (input: string) => (options.translate ? options.translate(input) : `[${input}]`) };
		},
	};
}

test('splits on blank lines and drops empty runs', () => {
	assert.deepEqual(splitParagraphs('One.\n\nTwo.\n\n\n\nThree.'), ['One.', 'Two.', 'Three.']);
});

test('treats a document with no blank line as a single paragraph', () => {
	assert.deepEqual(splitParagraphs('Just one line.'), ['Just one line.']);
});

test('translates each paragraph and rejoins with blank lines', async () => {
	const result = await translateArticleText('One.\n\nTwo.', 'vi', fakeDependencies({}));
	assert.equal(result?.content, '[One.]\n\n[Two.]');
});

test('reports the pair it used', async () => {
	const result = await translateArticleText('Hello.', 'vi', fakeDependencies({ detected: { language: 'en', confidence: 0.98 } }));
	assert.deepEqual(result?.translation, { sourceLanguage: 'en', targetLanguage: 'vi' });
});

test('returns null when the source already matches the target', async () => {
	const result = await translateArticleText('Xin chào.', 'vi', fakeDependencies({ detected: { language: 'vi', confidence: 0.99 } }));
	assert.equal(result, null);
});

test('returns null when detection is not confident', async () => {
	const result = await translateArticleText('????', 'vi', fakeDependencies({ detected: { language: 'en', confidence: 0.2 } }));
	assert.equal(result, null);
});

test('returns null when detection produced nothing', async () => {
	const result = await translateArticleText('Hello.', 'vi', fakeDependencies({ detected: null }));
	assert.equal(result, null);
});

test('creates the translator once for the whole document', async () => {
	let creations = 0;
	await translateArticleText(
		'A.\n\nB.\n\nC.',
		'vi',
		fakeDependencies({
			onCreate: () => {
				creations += 1;
			},
		}),
	);
	assert.equal(creations, 1);
});

test('preserves paragraph count even when a paragraph translates to empty', async () => {
	const result = await translateArticleText(
		'Keep.\n\nDrop.',
		'vi',
		fakeDependencies({
			translate: (input) => (input === 'Drop.' ? '' : input),
		}),
	);
	assert.equal(result?.content, 'Keep.\n\nDrop.');
});

test('propagates a translator failure rather than returning partial text', async () => {
	const dependencies: TranslationDependencies = {
		detectLanguage: async () => ({ language: 'en', confidence: 1 }),
		createTranslator: async () => ({
			translate: async (input: string) => {
				if (input === 'Two.') throw new Error('model failed');
				return `[${input}]`;
			},
		}),
	};
	await assert.rejects(() => translateArticleText('One.\n\nTwo.', 'vi', dependencies), /model failed/);
});
