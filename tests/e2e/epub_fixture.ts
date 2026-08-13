import JSZip from 'jszip';

/** Builds a minimal but structurally valid EPUB 3 archive in memory. */
export async function buildEpubFixture(chapters: { title: string; body: string }[]): Promise<Buffer> {
	const archive = new JSZip();
	archive.file('mimetype', 'application/epub+zip');
	archive.file(
		'META-INF/container.xml',
		`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
	);

	const manifestItems = chapters
		.map((_, index) => `<item id="c${index}" href="chapter${index}.xhtml" media-type="application/xhtml+xml"/>`)
		.join('');
	const spineItems = chapters.map((_, index) => `<itemref idref="c${index}"/>`).join('');
	// An untitled entry stands for front matter — a cover or title page the navigation skips.
	const navLinks = chapters
		.map((chapter, index) => (chapter.title ? `<li><a href="chapter${index}.xhtml">${chapter.title}</a></li>` : ''))
		.join('');
	archive.file(
		'OEBPS/nav.xhtml',
		`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${navLinks}</ol></nav></body></html>`,
	);
	archive.file(
		'OEBPS/content.opf',
		`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture Book</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifestItems}</manifest><spine>${spineItems}</spine></package>`,
	);

	chapters.forEach((chapter, index) => {
		archive.file(
			`OEBPS/chapter${index}.xhtml`,
			`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapter.title}</title></head><body><h1>${chapter.title}</h1><p>${chapter.body}</p></body></html>`,
		);
	});

	return archive.generateAsync({ type: 'nodebuffer' });
}
