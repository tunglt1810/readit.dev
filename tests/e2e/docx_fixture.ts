import JSZip from 'jszip';

const NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** Builds a minimal but structurally valid .docx archive in memory. */
export async function buildDocxFixture(paragraphs: string[]): Promise<Buffer> {
	const archive = new JSZip();
	const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
	archive.file('word/document.xml', `<?xml version="1.0"?><w:document ${NAMESPACE}><w:body>${body}</w:body></w:document>`);
	archive.file(
		'docProps/core.xml',
		`<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture Document</dc:title></cp:coreProperties>`,
	);
	return archive.generateAsync({ type: 'nodebuffer' });
}
