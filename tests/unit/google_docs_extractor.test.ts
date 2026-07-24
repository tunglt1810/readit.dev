import assert from 'node:assert/strict';
import test from 'node:test';
import {
	extractGoogleDocsArticle,
	fetchWithTimeout,
	type GoogleDocsFetch,
	parseGoogleDocsDocumentId,
} from '../../src/content/google_docs_extractor.ts';
import { GOOGLE_DOCS_EXPORT_UNAVAILABLE } from '../../src/shared/constants.ts';

test('parses only Docs document URLs', () => {
	assert.equal(parseGoogleDocsDocumentId('https://docs.google.com/document/d/google-doc-id/edit?tab=t.0'), 'google-doc-id');
	assert.equal(parseGoogleDocsDocumentId('https://docs.google.com/spreadsheets/d/google-doc-id/edit'), null);
	assert.equal(parseGoogleDocsDocumentId('https://example.com/document/d/google-doc-id/edit'), null);
	assert.equal(parseGoogleDocsDocumentId('https://docs.google.com/document/u/0/edit'), null);
});

test('creates an Article from same-origin plain text without collapsing paragraphs', async () => {
	const calls: Array<{ url: string; credentials: string | undefined }> = [];
	const fetcher: GoogleDocsFetch = async (url, init) => {
		calls.push({ url, credentials: init?.credentials });
		return {
			ok: true,
			headers: new Headers({ 'content-type': 'text/plain; charset=utf-8' }),
			text: async () => 'Đoạn đầu.\r\n\r\nĐoạn sau.\r\n',
		};
	};

	const result = await extractGoogleDocsArticle(
		{
			url: 'https://docs.google.com/document/d/google-doc-id/edit?tab=t.0',
			title: 'Tài liệu thử nghiệm - Google Tài liệu',
			lang: 'vi',
		},
		fetcher,
	);

	assert.deepEqual(result, {
		success: true,
		article: {
			title: 'Tài liệu thử nghiệm - Google Tài liệu',
			content: 'Đoạn đầu.\n\nĐoạn sau.',
			url: 'https://docs.google.com/document/d/google-doc-id/edit?tab=t.0',
			lang: 'vi',
		},
	});
	assert.deepEqual(calls, [
		{
			url: 'https://docs.google.com/document/d/google-doc-id/export?format=txt',
			credentials: 'same-origin',
		},
	]);
});

test('returns the shared code for denied, non-text, empty, and rejected exports', async () => {
	const response =
		(ok: boolean, contentType: string, text: string): GoogleDocsFetch =>
		async () => ({
			ok,
			headers: new Headers({ 'content-type': contentType }),
			text: async () => text,
		});
	const rejected: GoogleDocsFetch = async () => Promise.reject(new Error('network unavailable'));
	const abortRejected: GoogleDocsFetch = async () => Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
	const page = { url: 'https://docs.google.com/document/d/google-doc-id/edit', title: 'Doc', lang: 'en' };

	for (const fetcher of [
		response(false, 'text/plain', ''),
		response(true, 'text/html', '<html></html>'),
		response(true, 'text/plain', ' \r\n '),
		rejected,
		abortRejected,
	]) {
		assert.deepEqual(await extractGoogleDocsArticle(page, fetcher), {
			success: false,
			error: GOOGLE_DOCS_EXPORT_UNAVAILABLE,
		});
	}
});

test('fetchWithTimeout aborts a hung fetch once the timeout elapses', async () => {
	let observedSignal: AbortSignal | undefined;
	const hangingFetcher: GoogleDocsFetch = (_url, init) =>
		new Promise((_resolve, reject) => {
			observedSignal = init?.signal;
			init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
		});

	await assert.rejects(
		fetchWithTimeout(hangingFetcher, 'https://docs.google.com/document/d/google-doc-id/export?format=txt', 20),
		(error: unknown) => error instanceof DOMException && error.name === 'AbortError',
	);
	assert.equal(observedSignal?.aborted, true);
});
