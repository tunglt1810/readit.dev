import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSelectedTextRequest } from '../../src/background/selected_text_request.ts';

const sender = {
	frameId: 0,
	tabId: 42,
	windowId: 7,
	title: 'Selection page',
	url: 'https://readit.test/selection-button',
};

test('prepares a selected-text Article from trusted sender metadata', () => {
	assert.deepEqual(prepareSelectedTextRequest({ selectionText: '  Nội dung mới  ', pageLanguage: 'vi-VN' }, sender), {
		tabId: 42,
		windowId: 7,
		title: 'Selection page',
		url: 'https://readit.test/selection-button',
		article: {
			title: 'Selection page',
			content: 'Nội dung mới',
			url: 'https://readit.test/selection-button',
			lang: 'vi',
		},
	});
});

test('rejects child frames, unsupported protocols, missing ids, and empty text', () => {
	assert.equal(prepareSelectedTextRequest({ selectionText: 'Text', pageLanguage: 'en' }, { ...sender, frameId: 1 }), null);
	assert.equal(prepareSelectedTextRequest({ selectionText: 'Text', pageLanguage: 'en' }, { ...sender, url: 'chrome://settings' }), null);
	assert.equal(prepareSelectedTextRequest({ selectionText: 'Text', pageLanguage: 'en' }, { ...sender, url: 'not a URL' }), null);
	assert.equal(prepareSelectedTextRequest({ selectionText: 'Text', pageLanguage: 'en' }, { ...sender, tabId: undefined }), null);
	assert.equal(prepareSelectedTextRequest({ selectionText: '   ', pageLanguage: 'en' }, sender), null);
});
