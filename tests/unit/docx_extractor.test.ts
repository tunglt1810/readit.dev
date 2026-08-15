import JSZip from 'jszip';

import assert from 'node:assert/strict';
import test from 'node:test';
import { DOCX_ERROR_CODES } from '../../src/shared/constants.ts';
import { DocxError, extractDocxText } from '../../src/shared/docx_extractor.ts';

const NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A .docx is a ZIP; only word/document.xml is ever read, plus docProps/core.xml for the title. */
async function buildDocx(bodyXml: string, coreXml?: string): Promise<ArrayBuffer> {
	const archive = new JSZip();
	archive.file('word/document.xml', `<?xml version="1.0"?><w:document ${NAMESPACE}><w:body>${bodyXml}</w:body></w:document>`);
	if (coreXml) {
		archive.file('docProps/core.xml', coreXml);
	}
	const buffer = await archive.generateAsync({ type: 'nodebuffer' });
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function paragraph(...runs: string[]): string {
	return `<w:p>${runs.map((run) => `<w:r><w:t>${run}</w:t></w:r>`).join('')}</w:p>`;
}

test('paragraphs are joined into blocks in document order', async () => {
	const bytes = await buildDocx(`${paragraph('First paragraph.')}${paragraph('Second paragraph.')}`);
	const result = await extractDocxText(bytes, 'Report.docx');
	assert.equal(result.content, 'First paragraph.\n\nSecond paragraph.');
});

test('runs inside one paragraph stay on one line', async () => {
	const bytes = await buildDocx(paragraph('Split ', 'across ', 'runs.'));
	assert.equal((await extractDocxText(bytes, 'Report.docx')).content, 'Split across runs.');
});

test('tabs and line breaks become spaces', async () => {
	const bytes = await buildDocx(`<w:p><w:r><w:t>Left</w:t><w:tab/><w:t>Right</w:t><w:br/><w:t>Below</w:t></w:r></w:p>`);
	assert.equal((await extractDocxText(bytes, 'Report.docx')).content, 'Left Right Below');
});

test('text inside a table is read in place', async () => {
	const cell = (value: string) => `<w:tc>${paragraph(value)}</w:tc>`;
	const bytes = await buildDocx(`${paragraph('Before the table.')}<w:tbl><w:tr>${cell('Cell A')}${cell('Cell B')}</w:tr></w:tbl>`);
	assert.equal((await extractDocxText(bytes, 'Report.docx')).content, 'Before the table.\n\nCell A\n\nCell B');
});

test('empty paragraphs are dropped', async () => {
	const bytes = await buildDocx(`${paragraph('Text.')}<w:p/>${paragraph('   ')}${paragraph('More.')}`);
	assert.equal((await extractDocxText(bytes, 'Report.docx')).content, 'Text.\n\nMore.');
});

test('paragraph properties are not mistaken for a paragraph', async () => {
	const bytes = await buildDocx(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Heading text.</w:t></w:r></w:p>`);
	assert.equal((await extractDocxText(bytes, 'Report.docx')).content, 'Heading text.');
});

test('escaped characters are decoded', async () => {
	const bytes = await buildDocx(paragraph('Tom &amp; Jerry &lt;friends&gt; &#78;o. 1'));
	assert.equal((await extractDocxText(bytes, 'Report.docx')).content, 'Tom & Jerry <friends> No. 1');
});

test('the core properties title wins over the file name', async () => {
	const core = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quarterly Report</dc:title></cp:coreProperties>`;
	const bytes = await buildDocx(paragraph('Body text.'), core);
	assert.equal((await extractDocxText(bytes, 'Report.docx')).title, 'Quarterly Report');
});

test('a document with no title falls back to the file name', async () => {
	const bytes = await buildDocx(paragraph('Body text.'));
	assert.equal((await extractDocxText(bytes, 'Report.docx')).title, 'Report.docx');
});

test('a corrupt archive reports a parse failure', async () => {
	await assert.rejects(
		() => extractDocxText(new Uint8Array([1, 2, 3, 4]).buffer, 'Broken.docx'),
		(error: unknown) => error instanceof DocxError && error.code === DOCX_ERROR_CODES.parseFailed,
	);
});

test('an archive without word/document.xml reports a parse failure', async () => {
	const archive = new JSZip();
	archive.file('docProps/core.xml', '<x/>');
	const buffer = await archive.generateAsync({ type: 'nodebuffer' });
	await assert.rejects(
		() => extractDocxText(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, 'Odd.docx'),
		(error: unknown) => error instanceof DocxError && error.code === DOCX_ERROR_CODES.parseFailed,
	);
});

test('a document with no text reports that text is unavailable', async () => {
	const bytes = await buildDocx(`<w:p/><w:p/>`);
	await assert.rejects(
		() => extractDocxText(bytes, 'Images.docx'),
		(error: unknown) => error instanceof DocxError && error.code === DOCX_ERROR_CODES.textUnavailable,
	);
});
