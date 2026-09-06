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
 * `internalSilenceMs` is the pause Supertonic renders inside the unit for units with no
 * `pauseAfterMs`; here it becomes a trailing `<break>` so both engines produce the same cadence.
 */
export function buildSsml(input: { text: string; voice: string; locale: string; speed: number; internalSilenceMs: number }): string {
	const pause = input.internalSilenceMs > 0 ? `<break time='${Math.round(input.internalSilenceMs)}ms'/>` : '';
	return (
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${input.locale}'>` +
		`<voice name='${input.voice}'>` +
		`<prosody pitch='+0Hz' rate='${prosodyRate(input.speed)}' volume='+0%'>` +
		`${escapeXml(input.text)}${pause}` +
		`</prosody></voice></speak>`
	);
}
