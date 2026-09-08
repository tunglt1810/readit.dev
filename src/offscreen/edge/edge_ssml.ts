function escapeXml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

/**
 * Supertonic takes a speed multiplier; SSML takes a percentage delta from the voice's natural
 * rate. 1.5 means "half again as fast", which is `+50%`.
 */
function prosodyRate(speed: number): string {
	const percent = Math.round((speed - 1) * 100);
	return `${percent >= 0 ? '+' : ''}${percent}%`;
}

/**
 * One synthesis request.
 *
 * The readaloud endpoint accepts only `speak > voice > prosody > text`; every structural tag,
 * `<break>` included, closes the connection with 1007. Trailing silence is added to the decoded
 * samples instead — see edge_provider.ts.
 */
export function buildSsml(input: { text: string; voice: string; locale: string; speed: number }): string {
	return (
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${input.locale}'>` +
		`<voice name='${input.voice}'>` +
		`<prosody pitch='+0Hz' rate='${prosodyRate(input.speed)}' volume='+0%'>` +
		`${escapeXml(input.text)}` +
		`</prosody></voice></speak>`
	);
}
