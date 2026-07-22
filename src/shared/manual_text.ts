export function normalizeManualText(text: string): string {
	return text
		.normalize('NFKC')
		.replace(/\r\n?/gu, '\n')
		.split('\n')
		.map((line) => line.replace(/[\t ]+/gu, ' ').trimEnd())
		.join('\n')
		.trim();
}
