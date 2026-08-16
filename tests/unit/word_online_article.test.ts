import JSZip from 'jszip';

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWordOnlineArticle } from '../../src/background/word_online_article.ts';
import { bytesToBase64 } from '../../src/shared/base64.ts';
import { WORD_ONLINE_DOWNLOAD_UNAVAILABLE } from '../../src/shared/constants.ts';

const NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const SOURCE = {
	url: 'https://onedrive.live.com/personal/cid/_layouts/15/doc.aspx?sourcedoc=%7B2c444ed6-0def-4010-82d2-79c12f3ec8c5%7D',
	title: 'Tài liệu.docx',
	lang: 'en',
};

async function docxBase64(paragraphs: string[], title?: string): Promise<string> {
	const archive = new JSZip();
	const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
	archive.file('word/document.xml', `<?xml version="1.0"?><w:document ${NAMESPACE}><w:body>${body}</w:body></w:document>`);
	if (title) {
		archive.file(
			'docProps/core.xml',
			`<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`,
		);
	}
	const buffer = await archive.generateAsync({ type: 'nodebuffer' });
	return bytesToBase64(new Uint8Array(buffer));
}

test('builds an Article using the title stored inside the document', async () => {
	const result = await buildWordOnlineArticle(await docxBase64(['First paragraph.', 'Second paragraph.'], 'Quarterly Report'), SOURCE);

	assert.deepEqual(result, {
		success: true,
		readableSurface: 'document-reader',
		article: {
			title: 'Quarterly Report',
			content: 'First paragraph.\n\nSecond paragraph.',
			url: SOURCE.url,
			lang: 'en',
		},
	});
});

test('falls back to the page title when the document declares none', async () => {
	const result = await buildWordOnlineArticle(await docxBase64(['Only paragraph.']), SOURCE);
	assert.equal(result.success === true && result.article.title, 'Tài liệu.docx');
});

test('detects the language from the extracted text rather than the page', async () => {
	const result = await buildWordOnlineArticle(
		await docxBase64(['Chia tay không chỉ là buồn trong lòng, mà còn là một cú sốc mạnh với não bộ và cơ thể.']),
		SOURCE,
	);
	assert.equal(result.success === true && result.article.lang, 'vi');
});

test('reports the shared code when the archive is not a Word document', async () => {
	const archive = new JSZip();
	archive.file('xl/workbook.xml', '<workbook/>');
	const buffer = await archive.generateAsync({ type: 'nodebuffer' });

	assert.deepEqual(await buildWordOnlineArticle(bytesToBase64(new Uint8Array(buffer)), SOURCE), {
		success: false,
		error: WORD_ONLINE_DOWNLOAD_UNAVAILABLE,
	});
});

test('reports the shared code when the document has no text', async () => {
	assert.deepEqual(await buildWordOnlineArticle(await docxBase64([]), SOURCE), {
		success: false,
		error: WORD_ONLINE_DOWNLOAD_UNAVAILABLE,
	});
});
