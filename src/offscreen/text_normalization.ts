export interface NormalizedSourceText {
	/**
	 * The Hard Paragraph Boundary metadata, carried as membership rather than offsets: each entry is
	 * one paragraph with its whitespace already collapsed, and every boundary between two entries is
	 * a hard one. It survives whitespace normalization and never reaches `SpeechUnit.text`.
	 */
	paragraphs: readonly string[];
	/** The same paragraphs as one string, for consumers that only accept text (the Vietnamese normalizer). */
	planningText: string;
}

const SENTENCE_TERMINAL_PATTERN = /[.!?…]/u;

function normalizeParagraph(text: string): string {
	return text.replace(/\s+/gu, ' ').trim();
}

export function normalizeSourceText(text: string): NormalizedSourceText {
	if (!text) {
		return { paragraphs: [], planningText: '' };
	}

	const normalizedNfc = text.normalize('NFC').replace(/\r\n?/gu, '\n');
	const paragraphs: string[] = [];
	let currentParagraph = '';
	let index = 0;

	function finishParagraph(): void {
		const paragraph = normalizeParagraph(currentParagraph);
		if (paragraph) {
			paragraphs.push(paragraph);
		}
		currentParagraph = '';
	}

	while (index < normalizedNfc.length) {
		if (normalizedNfc[index] !== '\n') {
			currentParagraph += normalizedNfc[index];
			index++;
			continue;
		}

		const blankLineRun = normalizedNfc.slice(index).match(/^\n[\t\p{Zs}]*\n(?:[\t\p{Zs}]*\n)*/u);
		if (blankLineRun) {
			finishParagraph();
			index += blankLineRun[0].length;
			continue;
		}

		const finalCharacter = currentParagraph.trimEnd().at(-1) ?? '';
		if (SENTENCE_TERMINAL_PATTERN.test(finalCharacter)) {
			finishParagraph();
		} else if (currentParagraph && !currentParagraph.endsWith(' ')) {
			currentParagraph += ' ';
		}
		index++;
	}
	finishParagraph();

	return { paragraphs, planningText: paragraphs.join('\n\n') };
}
