/**
 * A resumed chapter is played as a slice of its full text, so highlight offsets
 * reported later are slice-relative. Callers keep `baseOffset` to convert them back.
 */
export function resolveChapterStart(chapterText: string, charOffset: number): { text: string; baseOffset: number } {
	if (!Number.isFinite(charOffset) || charOffset <= 0 || charOffset >= chapterText.length) {
		return { text: chapterText, baseOffset: 0 };
	}
	return { text: chapterText.slice(charOffset), baseOffset: charOffset };
}

export function toAbsoluteOffset(baseOffset: number, rangeStart: number): number {
	return baseOffset + rangeStart;
}
