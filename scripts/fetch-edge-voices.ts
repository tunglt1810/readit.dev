// Regenerates public/assets/edge_voices.json. Run by hand when Microsoft adds voices; the
// extension never fetches this list at runtime.
import { EDGE_USER_AGENT, SEC_MS_GEC_VERSION, secMsGecToken, TRUSTED_CLIENT_TOKEN } from '../src/offscreen/edge/gec_token.ts';

const gec = await secMsGecToken(Date.now());
const url =
	`https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list` +
	`?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

const response = await fetch(url, { headers: { 'User-Agent': EDGE_USER_AGENT } });
if (!response.ok) {
	throw new Error(`voices/list returned ${response.status}`);
}

type RawVoice = { ShortName: string; Locale: string; Gender: string; FriendlyName: string };

const raw = (await response.json()) as RawVoice[];
const voices = raw
	.map((voice) => ({
		shortName: voice.ShortName,
		locale: voice.Locale,
		gender: voice.Gender === 'Male' ? 'male' : 'female',
		friendlyName: voice.FriendlyName,
	}))
	.toSorted((a, b) => a.shortName.localeCompare(b.shortName));

await Bun.write('public/assets/edge_voices.json', `${JSON.stringify(voices, null, '\t')}\n`);
console.log(`wrote ${voices.length} voices`);
