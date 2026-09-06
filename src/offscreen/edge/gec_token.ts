/** The token the Edge read-aloud client ships with; it is not a secret and not per-user. */
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

/**
 * Microsoft raises this floor over time: 1-130.0.2849.68 answers 403 today while 1-133 and above
 * are accepted. A 403 on every handshake is the symptom of it having moved again.
 */
export const SEC_MS_GEC_VERSION = '1-141.0.3537.57';

/** The handshake is rejected with 403 unless the User-Agent carries an `Edg/` token. */
export const EDGE_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const TICKS_PER_SECOND = 10_000_000;
const FIVE_MINUTES_IN_TICKS = 300 * TICKS_PER_SECOND;

/**
 * The `Sec-MS-GEC` handshake token: SHA-256 over the Windows file time floored to the current
 * five-minute window, concatenated with the trusted client token, as uppercase hex.
 *
 * Flooring is what lets client and server agree without exchanging anything, and it is also why a
 * machine clock more than five minutes off gets a 403.
 */
export async function secMsGecToken(nowMs: number): Promise<string> {
	const ticks = Math.floor((nowMs / 1000 + WINDOWS_EPOCH_OFFSET_SECONDS) * TICKS_PER_SECOND);
	const floored = ticks - (ticks % FIVE_MINUTES_IN_TICKS);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${floored}${TRUSTED_CLIENT_TOKEN}`));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase();
}
