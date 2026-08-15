const DEFAULT_TARGET_CHARS = 1800;

/**
 * DOCX carries no pagination — Word computes it at layout time — so a document that needs a page
 * number gets evenly sized ones instead. Breaking only at paragraph boundaries keeps a page from
 * starting mid-sentence, and makes the numbering reproducible for the same text.
 */
export function computeVirtualPageStarts(text: string, targetChars = DEFAULT_TARGET_CHARS): number[] {
	const starts = [0];
	let pageStart = 0;
	let cursor = 0;
	while (cursor < text.length) {
		const separator = text.indexOf('\n\n', cursor);
		if (separator === -1) {
			break;
		}
		const nextParagraph = separator + 2;
		// A paragraph longer than the target still ends its page: the break comes after it, not inside.
		if (nextParagraph - pageStart >= targetChars) {
			starts.push(nextParagraph);
			pageStart = nextParagraph;
		}
		cursor = nextParagraph;
	}
	return starts;
}
