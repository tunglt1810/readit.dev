import assert from 'node:assert/strict';
import test from 'node:test';
import {
	extractWordOnlineDocx,
	fetchWithTimeout,
	parseWordOnlineDocument,
	type WordOnlineFetch,
} from '../../src/content/word_online_extractor.ts';
import { WORD_ONLINE_DOWNLOAD_UNAVAILABLE } from '../../src/shared/constants.ts';

const GUID = '2c444ed6-0def-4010-82d2-79c12f3ec8c5';

test('accepts OneDrive and SharePoint document pages', () => {
	assert.deepEqual(
		parseWordOnlineDocument(
			`https://onedrive.live.com/personal/ac20f9f43d21e582/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D&action=edit`,
		),
		{ sitePath: '/personal/ac20f9f43d21e582', documentId: GUID },
	);
	assert.deepEqual(parseWordOnlineDocument(`https://onedrive.live.com/personal/cid/_layouts/15/Doc.aspx?sourcedoc={${GUID}}`), {
		sitePath: '/personal/cid',
		documentId: GUID,
	});
	assert.deepEqual(parseWordOnlineDocument(`https://onedrive.live.com/personal/cid/_layouts/15/doc2.aspx?sourcedoc=${GUID}`), {
		sitePath: '/personal/cid',
		documentId: GUID,
	});
	assert.deepEqual(
		parseWordOnlineDocument(`https://contoso.sharepoint.com/sites/marketing/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D`),
		{ sitePath: '/sites/marketing', documentId: GUID },
	);
	assert.deepEqual(
		parseWordOnlineDocument(`https://contoso-my.sharepoint.com/personal/bez_contoso_com/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D`),
		{ sitePath: '/personal/bez_contoso_com', documentId: GUID },
	);
});

test('reads the identifier from resid, which OneDrive uses instead of sourcedoc', () => {
	assert.deepEqual(
		parseWordOnlineDocument(
			`https://onedrive.live.com/personal/ac20f9f43d21e582/_layouts/15/doc.aspx?resid=${GUID}&cid=ac20f9f43d21e582`,
		),
		{ sitePath: '/personal/ac20f9f43d21e582', documentId: GUID },
	);
});

test('rejects look-alike hosts, wrong schemes, and malformed identifiers', () => {
	const rejected = [
		`http://onedrive.live.com/personal/cid/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D`,
		`https://evilsharepoint.com/sites/x/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D`,
		`https://contoso.sharepoint.com.evil.com/sites/x/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D`,
		'https://docs.google.com/document/d/abc/edit',
		'https://onedrive.live.com/personal/cid/_layouts/15/doc.aspx',
		'https://onedrive.live.com/personal/cid/_layouts/15/doc.aspx?sourcedoc=%7Bnot-a-guid%7D',
		`https://onedrive.live.com/personal/cid/_layouts/15/download.aspx?sourcedoc=%7B${GUID}%7D`,
		`https://onedrive.live.com/personal/cid/Documents/File.docx?sourcedoc=%7B${GUID}%7D`,
		'not a url at all',
	];
	for (const url of rejected) {
		assert.equal(parseWordOnlineDocument(url), null, url);
	}
});

const PAGE = {
	url: `https://onedrive.live.com/personal/cid/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D&action=edit`,
	title: 'Tài liệu',
	lang: 'vi',
};
const DOWNLOAD_URL = `https://onedrive.live.com/personal/cid/_layouts/15/download.aspx?UniqueId=${GUID}`;

function docxBytes(extra = 0): Uint8Array {
	const bytes = new Uint8Array(4 + extra);
	bytes.set([0x50, 0x4b, 0x03, 0x04]);
	return bytes;
}

function respond(options: { ok?: boolean; body?: Uint8Array; contentLength?: string }): WordOnlineFetch {
	return async () => ({
		ok: options.ok ?? true,
		headers: new Headers(options.contentLength ? { 'content-length': options.contentLength } : {}),
		arrayBuffer: async () => (options.body ?? docxBytes()).buffer as ArrayBuffer,
	});
}

test('returns null for pages that are not Word Online documents', async () => {
	const untouched: WordOnlineFetch = async () => {
		throw new Error('fetch must not run');
	};
	assert.equal(await extractWordOnlineDocx({ url: 'https://example.com/article', title: 'A', lang: 'en' }, untouched), null);
});

test('downloads from the same-origin endpoint built from the parsed identifier', async () => {
	const calls: Array<{ url: string; credentials: string | undefined }> = [];
	const fetcher: WordOnlineFetch = async (url, init) => {
		calls.push({ url, credentials: init?.credentials });
		return { ok: true, headers: new Headers(), arrayBuffer: async () => docxBytes(8).buffer as ArrayBuffer };
	};

	const result = await extractWordOnlineDocx(PAGE, fetcher);

	assert.deepEqual(calls, [{ url: DOWNLOAD_URL, credentials: 'same-origin' }]);
	assert.equal(result?.success, true);
	assert.equal(result?.success === true && result.readableSurface, 'document-reader');
	assert.deepEqual(result?.success === true && result.source, PAGE);
	assert.ok(result?.success === true && result.docxBase64.startsWith('UEsDBA'));
});

test('reports the shared code for every download failure', async () => {
	const oversized = String(26 * 1024 * 1024);
	const rejected: WordOnlineFetch = async () => Promise.reject(new Error('network unavailable'));
	const aborted: WordOnlineFetch = async () => Promise.reject(new DOMException('The operation was aborted', 'AbortError'));

	for (const fetcher of [
		respond({ ok: false }),
		respond({ body: new Uint8Array(0) }),
		respond({ body: new TextEncoder().encode('<html>Authenticate</html>') }),
		respond({ contentLength: oversized }),
		rejected,
		aborted,
	]) {
		assert.deepEqual(await extractWordOnlineDocx(PAGE, fetcher), {
			success: false,
			error: WORD_ONLINE_DOWNLOAD_UNAVAILABLE,
		});
	}
});

test('fetchWithTimeout aborts a hung download once the timeout elapses', async () => {
	let observedSignal: AbortSignal | undefined;
	const hanging: WordOnlineFetch = (_url, init) =>
		new Promise((_resolve, reject) => {
			observedSignal = init?.signal;
			init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
		});

	await assert.rejects(
		fetchWithTimeout(hanging, DOWNLOAD_URL, 20),
		(error: unknown) => error instanceof DOMException && error.name === 'AbortError',
	);
	assert.equal(observedSignal?.aborted, true);
});
