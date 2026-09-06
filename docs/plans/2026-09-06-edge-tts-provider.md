# Edge TTS Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Microsoft's Edge read-aloud service as a second speech provider, make it the default, and keep on-device Supertonic as an automatic fallback.

**Architecture:** A `SpeechProvider` interface sits between `offscreen.ts` and the two engines. `SupertonicProvider` wraps today's ONNX path unchanged; `EdgeProvider` opens a WebSocket from the offscreen document, submits SSML, and returns decoded audio plus real per-word timings. Provider choice happens once per reading session; failures downgrade the session to Supertonic.

**Tech Stack:** TypeScript, Bun (`bun test` with `node:test`), Chrome MV3 offscreen document, declarativeNetRequest, Web Audio `decodeAudioData`, React 19 for settings UI.

**Spec:** `docs/specs/2026-09-06-edge-tts-provider-design.md`

## Global Constraints

- Runtime is **Bun 1.4+ only**. Never `npm`, `npx`, `pnpm`, or `node`. Tests run with `bun test tests/unit`; binaries with `bunx`.
- Unit tests use `node:test` + `node:assert/strict`, matching every file in `tests/unit/`.
- Endpoint: `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
- `TrustedClientToken` = `6A5AA1D4EAFF4E9FB37E23D68491D6F4`
- `Sec-MS-GEC` = uppercase hex SHA-256 of `` `${windowsFileTimeFlooredTo5Minutes}${TrustedClientToken}` ``
- `Sec-MS-GEC-Version` = `1-141.0.3537.57`. **Must stay at or above `1-133`**; `1-130.0.2849.68` returns 403.
- The forged `User-Agent` must contain `Edg/`. Use exactly: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0`
- Audio output format: `audio-24khz-48kbitrate-mono-mp3`. PCM formats are rejected with close code 1007.
- **The WebSocket must be constructed in the offscreen document.** Constructed in the service worker, declarativeNetRequest silently skips the handshake (crbug 1285664) and Microsoft answers 403.
- Run `graphify update .` after modifying code, per `CLAUDE.md`.
- Documentation files are written in English.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/offscreen/speech_provider.ts` | `SpeechProvider` / `SynthesizedUnit` / `SynthesizedPlayback` types |
| `src/offscreen/supertonic_provider.ts` | Wraps the existing ONNX synthesis path |
| `src/offscreen/edge/gec_token.ts` | `Sec-MS-GEC` hash |
| `src/shared/edge_voices.ts` | Voice catalogue, `lang → locale → voice` mapping |
| `src/offscreen/edge/edge_ssml.ts` | SSML construction, speed and break translation |
| `src/offscreen/edge/edge_socket.ts` | WebSocket lifecycle, framing, `turn.end` assembly |
| `src/offscreen/edge/word_boundary_alignment.ts` | WordBoundary → `WordTimingWindow[]` alignment |
| `src/offscreen/edge/edge_provider.ts` | Composes socket + decode + alignment into a provider |
| `public/rules.json` | The DNR `modifyHeaders` rule |
| `public/assets/edge_voices.json` | Build-time voice catalogue |
| `scripts/fetch-edge-voices.ts` | Regenerates the catalogue |
| `docs/adr/0003-edge-tts-provider.md` | Records the non-obvious constraints |

**Modified:** `src/offscreen/offscreen.ts` (provider selection, coordinator type, fallback), `src/offscreen/audio.ts` (Supertonic call kept, re-exported), `src/offscreen/playback_preparation.ts` (re-plan helper), `src/shared/constants.ts` (storage keys), `src/shared/components/SettingsCard.tsx` (provider + voice UI), `public/manifest.json`, `rsbuild.config.ts` (Firefox branch), `scripts/validate-free-manifest.mjs` (permission allowlist), `docs/privacy-policy.md`, `description_vi.md`, `description_en.md`, `package.json`.

---

### Task 1: Firefox WebSocket header probe

The spec deliberately leaves Firefox unresolved. This task answers it before any Firefox-facing code is written. It is a throwaway probe, not shipped code.

**Files:**
- Create: `.tmp/firefox-ws-probe/` (throwaway, gitignored)
- Modify: `docs/adr/0003-edge-tts-provider.md` (created here with the finding)

- [ ] **Step 1: Build the Firefox bundle**

```bash
bun run build:firefox
```

- [ ] **Step 2: Write a throwaway MV3 probe extension for Firefox**

Copy the Chrome probe pattern: a page (not a background script) that opens a WebSocket to a local server which echoes back the handshake headers it saw. Firefox needs `webRequest` + `webRequestBlocking` and an `onBeforeSendHeaders` listener that rewrites `user-agent`, since Firefox's DNR support for WebSocket upgrades is what is being tested.

```javascript
// .tmp/firefox-ws-probe/ext/background.js
browser.webRequest.onBeforeSendHeaders.addListener(
	(details) => {
		const headers = details.requestHeaders.filter((h) => h.name.toLowerCase() !== 'user-agent');
		headers.push({
			name: 'User-Agent',
			value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
		});
		return { requestHeaders: headers };
	},
	{ urls: ['wss://speech.platform.bing.com/*', 'ws://127.0.0.1/*'] },
	['blocking', 'requestHeaders'],
);
```

- [ ] **Step 3: Run the probe with `bunx web-ext run`, pointed at the local header server**

Expected outcome is one of two, and both are acceptable results for this task:
- The local server reports the forged `Edg/` User-Agent, and the Bing handshake reaches `turn.end` with audio → Firefox shares the edge path.
- The local server reports Firefox's own User-Agent → Firefox keeps Supertonic as its default.

- [ ] **Step 4: Record the finding in a new ADR**

Create `docs/adr/0003-edge-tts-provider.md` documenting: why the WebSocket must live in the offscreen document (crbug 1285664), why the User-Agent is forged, that `Sec-MS-GEC-Version` has a moving floor that will need bumping, and the Firefox result from Step 3 with the date it was measured.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0003-edge-tts-provider.md
git commit -m "docs: record edge-tts constraints and the Firefox probe result"
```

---

### Task 2: GEC token

**Files:**
- Create: `src/offscreen/edge/gec_token.ts`
- Test: `tests/unit/edge_gec_token.test.ts`

**Interfaces:**
- Produces: `secMsGecToken(nowMs: number): Promise<string>`, `SEC_MS_GEC_VERSION`, `TRUSTED_CLIENT_TOKEN`, `EDGE_USER_AGENT`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/edge_gec_token.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { secMsGecToken, SEC_MS_GEC_VERSION, TRUSTED_CLIENT_TOKEN } from '../../src/offscreen/edge/gec_token.ts';

// 2026-09-06T12:03:47Z — deliberately not on a 5-minute boundary.
const SAMPLE_MS = Date.UTC(2026, 8, 6, 12, 3, 47);

async function expectedFor(ms: number): Promise<string> {
	const ticks = Math.floor((ms / 1000 + 11_644_473_600) * 10_000_000);
	const floored = ticks - (ticks % 3_000_000_000);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${floored}${TRUSTED_CLIENT_TOKEN}`));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase();
}

test('hashes the windows filetime floored to five minutes', async () => {
	assert.equal(await secMsGecToken(SAMPLE_MS), await expectedFor(SAMPLE_MS));
});

test('returns the same token anywhere inside one five-minute window', async () => {
	const early = await secMsGecToken(Date.UTC(2026, 8, 6, 12, 0, 1));
	const late = await secMsGecToken(Date.UTC(2026, 8, 6, 12, 4, 59));
	assert.equal(early, late);
});

test('changes token across a five-minute boundary', async () => {
	const before = await secMsGecToken(Date.UTC(2026, 8, 6, 12, 4, 59));
	const after = await secMsGecToken(Date.UTC(2026, 8, 6, 12, 5, 1));
	assert.notEqual(before, after);
});

test('is uppercase hex of a sha-256 digest', async () => {
	assert.match(await secMsGecToken(SAMPLE_MS), /^[0-9A-F]{64}$/u);
});

test('pins a version at or above the endpoint floor', () => {
	const minor = Number(SEC_MS_GEC_VERSION.split('-')[1].split('.')[0]);
	assert.ok(minor >= 133, `Sec-MS-GEC-Version ${SEC_MS_GEC_VERSION} is below the 1-133 floor`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/edge_gec_token.test.ts`
Expected: FAIL — cannot resolve `src/offscreen/edge/gec_token.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/offscreen/edge/gec_token.ts

/** The token the Edge read-aloud client ships with; it is not a secret and not per-user. */
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

/**
 * Microsoft raises this floor over time: 1-130.0.2849.68 answers 403 today while 1-133 and
 * above are accepted. A 403 on every handshake is the symptom of it having moved again.
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
 * five-minute window, concatenated with the trusted client token, as uppercase hex. Flooring is
 * what lets client and server agree without exchanging anything, and it is also why a machine
 * clock more than five minutes off gets a 403.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/edge_gec_token.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/edge/gec_token.ts tests/unit/edge_gec_token.test.ts
git commit -m "feat: add Sec-MS-GEC token derivation for edge-tts"
```

---

### Task 3: Voice catalogue and language mapping

**Files:**
- Create: `src/shared/edge_voices.ts`, `scripts/fetch-edge-voices.ts`, `public/assets/edge_voices.json`
- Test: `tests/unit/edge_voices.test.ts`

**Interfaces:**
- Consumes: `secMsGecToken`, `SEC_MS_GEC_VERSION`, `TRUSTED_CLIENT_TOKEN`, `EDGE_USER_AGENT` (Task 2)
- Produces: `EdgeVoice`, `localeForLanguage(lang: string): string | null`, `voicesForLanguage(lang: string): EdgeVoice[]`, `defaultVoiceForLanguage(lang: string): string | null`, `isEdgeSupportedLanguage(lang: string): boolean`

- [ ] **Step 1: Write the catalogue fetch script**

```ts
// scripts/fetch-edge-voices.ts
// Regenerates public/assets/edge_voices.json. Run by hand when Microsoft adds voices;
// the extension never fetches this list at runtime.
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
```

- [ ] **Step 2: Generate the catalogue**

Run: `bun scripts/fetch-edge-voices.ts`
Expected: `wrote 322 voices` (the exact count may drift; anything in the 300s is normal)

- [ ] **Step 3: Write the failing test**

```ts
// tests/unit/edge_voices.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	defaultVoiceForLanguage,
	isEdgeSupportedLanguage,
	localeForLanguage,
	voicesForLanguage,
} from '../../src/shared/edge_voices.ts';

test('maps a bare language code to a full locale', () => {
	assert.equal(localeForLanguage('vi'), 'vi-VN');
	assert.equal(localeForLanguage('en'), 'en-US');
});

test('accepts a full locale and regional variants', () => {
	assert.equal(localeForLanguage('en-GB'), 'en-GB');
	assert.equal(localeForLanguage('vi-VN'), 'vi-VN');
});

test('is case and separator insensitive', () => {
	assert.equal(localeForLanguage('VI'), 'vi-VN');
	assert.equal(localeForLanguage('en_GB'), 'en-GB');
});

test('rejects the Supertonic-only placeholder language', () => {
	assert.equal(localeForLanguage('na'), null);
	assert.equal(isEdgeSupportedLanguage('na'), false);
});

test('rejects an unknown language', () => {
	assert.equal(localeForLanguage('zzz'), null);
	assert.deepEqual(voicesForLanguage('zzz'), []);
	assert.equal(defaultVoiceForLanguage('zzz'), null);
});

test('lists exactly the Vietnamese voices', () => {
	const names = voicesForLanguage('vi').map((voice) => voice.shortName);
	assert.deepEqual(names, ['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural']);
});

test('picks a stable default voice for a language', () => {
	assert.equal(defaultVoiceForLanguage('vi'), 'vi-VN-HoaiMyNeural');
	assert.equal(defaultVoiceForLanguage('vi'), defaultVoiceForLanguage('vi'));
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test tests/unit/edge_voices.test.ts`
Expected: FAIL — cannot resolve `src/shared/edge_voices.ts`

- [ ] **Step 5: Write the implementation**

```ts
// src/shared/edge_voices.ts
import catalogue from '../../public/assets/edge_voices.json' with { type: 'json' };

export interface EdgeVoice {
	shortName: string;
	locale: string;
	gender: 'male' | 'female';
	friendlyName: string;
}

const VOICES = catalogue as EdgeVoice[];

/**
 * Preferred locale per bare language code. Microsoft ships several regional variants for the
 * big languages and the bare code has to resolve to exactly one of them; these are the variants
 * with the widest voice selection.
 */
const PREFERRED_LOCALES: Record<string, string> = {
	ar: 'ar-EG',
	en: 'en-US',
	es: 'es-ES',
	fr: 'fr-FR',
	nl: 'nl-NL',
	pt: 'pt-BR',
	sv: 'sv-SE',
	vi: 'vi-VN',
	zh: 'zh-CN',
};

function canonical(lang: string): string {
	return lang.trim().replaceAll('_', '-').toLowerCase();
}

const LOCALE_BY_LOWERCASE = new Map(VOICES.map((voice) => [voice.locale.toLowerCase(), voice.locale]));

/**
 * The locale whose voices should speak this content, or null when Microsoft has none. `na` is
 * Supertonic's placeholder for "language not detected" and deliberately resolves to null so the
 * caller falls back rather than guessing a locale.
 */
export function localeForLanguage(lang: string): string | null {
	const code = canonical(lang);
	if (code === 'na' || code === '') {
		return null;
	}
	const exact = LOCALE_BY_LOWERCASE.get(code);
	if (exact) {
		return exact;
	}
	const base = code.split('-')[0];
	const preferred = PREFERRED_LOCALES[base];
	if (preferred && LOCALE_BY_LOWERCASE.has(preferred.toLowerCase())) {
		return preferred;
	}
	const firstMatch = VOICES.find((voice) => voice.locale.toLowerCase().startsWith(`${base}-`));
	return firstMatch?.locale ?? null;
}

export function isEdgeSupportedLanguage(lang: string): boolean {
	return localeForLanguage(lang) !== null;
}

export function voicesForLanguage(lang: string): EdgeVoice[] {
	const locale = localeForLanguage(lang);
	return locale === null ? [] : VOICES.filter((voice) => voice.locale === locale);
}

/** The catalogue is sorted by shortName, so "first female, else first" is stable across builds. */
export function defaultVoiceForLanguage(lang: string): string | null {
	const voices = voicesForLanguage(lang);
	const preferred = voices.find((voice) => voice.gender === 'female') ?? voices[0];
	return preferred?.shortName ?? null;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/unit/edge_voices.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 7: Commit**

```bash
git add src/shared/edge_voices.ts scripts/fetch-edge-voices.ts public/assets/edge_voices.json tests/unit/edge_voices.test.ts
git commit -m "feat: add edge-tts voice catalogue and language mapping"
```

---

### Task 4: SSML construction

**Files:**
- Create: `src/offscreen/edge/edge_ssml.ts`
- Test: `tests/unit/edge_ssml.test.ts`

**Interfaces:**
- Produces: `buildSsml(input: { text: string; voice: string; locale: string; speed: number; internalSilenceMs: number }): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/edge_ssml.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSsml } from '../../src/offscreen/edge/edge_ssml.ts';

const base = { text: 'Hello', voice: 'en-US-AvaNeural', locale: 'en-US', speed: 1, internalSilenceMs: 0 };

test('wraps the text in a voice and prosody element', () => {
	const ssml = buildSsml(base);
	assert.match(ssml, /<voice name='en-US-AvaNeural'>/u);
	assert.match(ssml, /xml:lang='en-US'/u);
	assert.match(ssml, />Hello</u);
});

test('translates speed to a prosody rate percentage', () => {
	assert.match(buildSsml({ ...base, speed: 1.5 }), /rate='\+50%'/u);
	assert.match(buildSsml({ ...base, speed: 1 }), /rate='\+0%'/u);
	assert.match(buildSsml({ ...base, speed: 0.8 }), /rate='-20%'/u);
});

test('rounds fractional rates to whole percent', () => {
	assert.match(buildSsml({ ...base, speed: 1.125 }), /rate='\+13%'/u);
});

test('appends a break for internal silence', () => {
	assert.match(buildSsml({ ...base, internalSilenceMs: 300 }), /<break time='300ms'\/>/u);
});

test('omits the break when there is no internal silence', () => {
	assert.doesNotMatch(buildSsml(base), /<break/u);
});

test('escapes XML metacharacters in the text', () => {
	const ssml = buildSsml({ ...base, text: `Tom & Jerry <b> "x" 'y'` });
	assert.match(ssml, /Tom &amp; Jerry &lt;b&gt; &quot;x&quot; &apos;y&apos;/u);
	assert.doesNotMatch(ssml, /<b>/u);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/edge_ssml.test.ts`
Expected: FAIL — cannot resolve `src/offscreen/edge/edge_ssml.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/offscreen/edge/edge_ssml.ts

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
 * One synthesis request. `internalSilenceMs` is the pause Supertonic renders inside the unit for
 * units with no `pauseAfterMs`; here it becomes a trailing `<break>` so both engines produce the
 * same cadence.
 */
export function buildSsml(input: {
	text: string;
	voice: string;
	locale: string;
	speed: number;
	internalSilenceMs: number;
}): string {
	const pause = input.internalSilenceMs > 0 ? `<break time='${Math.round(input.internalSilenceMs)}ms'/>` : '';
	return (
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${input.locale}'>` +
		`<voice name='${input.voice}'>` +
		`<prosody pitch='+0Hz' rate='${prosodyRate(input.speed)}' volume='+0%'>` +
		`${escapeXml(input.text)}${pause}` +
		`</prosody></voice></speak>`
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/edge_ssml.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/edge/edge_ssml.ts tests/unit/edge_ssml.test.ts
git commit -m "feat: build SSML requests for edge-tts"
```

---

### Task 5: WebSocket client

**Files:**
- Create: `src/offscreen/edge/edge_socket.ts`
- Test: `tests/unit/edge_socket.test.ts`

**Interfaces:**
- Consumes: `secMsGecToken`, `SEC_MS_GEC_VERSION`, `TRUSTED_CLIENT_TOKEN` (Task 2)
- Produces: `EdgeWordBoundary { offsetMs: number; durationMs: number; text: string }`, `EdgeSynthesisResult { audio: Uint8Array; boundaries: EdgeWordBoundary[] }`, `EdgeSocketError`, `class EdgeSocket { constructor(deps: EdgeSocketDependencies); synthesize(ssml: string): Promise<EdgeSynthesisResult>; close(): void }`, `EdgeSocketDependencies { createSocket(url: string): WebSocketLike; now(): number; requestId(): string }`

The socket is injected so the test drives it without a network. `WebSocketLike` is the minimal surface used: `addEventListener`, `send`, `close`, `binaryType`, `readyState`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/edge_socket.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { EdgeSocket, EdgeSocketError, type WebSocketLike } from '../../src/offscreen/edge/edge_socket.ts';

class FakeSocket implements WebSocketLike {
	binaryType = 'blob';
	readyState = 0;
	sent: string[] = [];
	closed = false;
	private listeners = new Map<string, ((event: never) => void)[]>();

	addEventListener(type: string, listener: (event: never) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.closed = true;
	}
	emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) {
			(listener as (event: unknown) => void)(event);
		}
	}
	open(): void {
		this.readyState = 1;
		this.emit('open', {});
	}
	text(path: string, body: unknown): void {
		this.emit('message', { data: `X-RequestId:abc\r\nPath:${path}\r\n\r\n${JSON.stringify(body)}` });
	}
	audio(bytes: number[]): void {
		const header = new TextEncoder().encode('Path:audio\r\n');
		const frame = new Uint8Array(2 + header.length + bytes.length);
		new DataView(frame.buffer).setUint16(0, header.length);
		frame.set(header, 2);
		frame.set(bytes, 2 + header.length);
		this.emit('message', { data: frame.buffer });
	}
}

function makeSocket(): { socket: EdgeSocket; fake: FakeSocket; urls: string[] } {
	const urls: string[] = [];
	let fake!: FakeSocket;
	const socket = new EdgeSocket({
		createSocket: (url) => {
			urls.push(url);
			fake = new FakeSocket();
			return fake;
		},
		now: () => Date.UTC(2026, 8, 6, 12, 0, 0),
		requestId: () => 'abc',
	});
	return { socket, get fake() { return fake; }, urls } as never;
}

test('sends speech.config then the ssml, and resolves on turn.end', async () => {
	const harness = makeSocket();
	const pending = harness.socket.synthesize('<speak/>');
	await Promise.resolve();
	harness.fake.open();
	assert.equal(harness.fake.sent.length, 2);
	assert.match(harness.fake.sent[0], /Path:speech\.config/u);
	assert.match(harness.fake.sent[0], /audio-24khz-48kbitrate-mono-mp3/u);
	assert.match(harness.fake.sent[0], /"wordBoundaryEnabled":"true"/u);
	assert.match(harness.fake.sent[1], /Path:ssml/u);
	assert.match(harness.fake.sent[1], /X-RequestId:abc/u);

	harness.fake.text('turn.start', {});
	harness.fake.audio([1, 2, 3]);
	harness.fake.audio([4, 5]);
	harness.fake.text('audio.metadata', {
		Metadata: [{ Type: 'WordBoundary', Data: { Offset: 1_000_000, Duration: 4_750_000, text: { Text: 'Testing' } } }],
	});
	harness.fake.text('turn.end', {});

	const result = await pending;
	assert.deepEqual(Array.from(result.audio), [1, 2, 3, 4, 5]);
	assert.deepEqual(result.boundaries, [{ offsetMs: 100, durationMs: 475, text: 'Testing' }]);
});

test('includes the GEC token and version in the url', async () => {
	const harness = makeSocket();
	const pending = harness.socket.synthesize('<speak/>');
	await Promise.resolve();
	harness.fake.open();
	harness.fake.text('turn.end', {});
	await pending.catch(() => undefined);
	assert.match(harness.urls[0], /Sec-MS-GEC=[0-9A-F]{64}/u);
	assert.match(harness.urls[0], /Sec-MS-GEC-Version=1-1\d\d\./u);
	assert.match(harness.urls[0], /TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4/u);
});

test('rejects with EdgeSocketError when the socket closes before turn.end', async () => {
	const harness = makeSocket();
	const pending = harness.socket.synthesize('<speak/>');
	await Promise.resolve();
	harness.fake.open();
	harness.fake.emit('close', { code: 1006, reason: '' });
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof EdgeSocketError);
		assert.equal((error as EdgeSocketError).closeCode, 1006);
		return true;
	});
});

test('rejects when turn.end arrives with no audio', async () => {
	const harness = makeSocket();
	const pending = harness.socket.synthesize('<speak/>');
	await Promise.resolve();
	harness.fake.open();
	harness.fake.text('turn.end', {});
	await assert.rejects(pending, EdgeSocketError);
});

test('reuses one connection across sequential requests', async () => {
	const harness = makeSocket();
	const first = harness.socket.synthesize('<speak>1</speak>');
	await Promise.resolve();
	harness.fake.open();
	harness.fake.audio([1]);
	harness.fake.text('turn.end', {});
	await first;

	const second = harness.socket.synthesize('<speak>2</speak>');
	await Promise.resolve();
	harness.fake.audio([2]);
	harness.fake.text('turn.end', {});
	await second;

	assert.equal(harness.urls.length, 1, 'expected the second request to reuse the open socket');
	assert.equal(harness.fake.sent.length, 3, 'speech.config once, then one ssml per request');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/edge_socket.test.ts`
Expected: FAIL — cannot resolve `src/offscreen/edge/edge_socket.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/offscreen/edge/edge_socket.ts
import { SEC_MS_GEC_VERSION, secMsGecToken, TRUSTED_CLIENT_TOKEN } from './gec_token.ts';

const ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

/**
 * Only mp3 and opus are accepted; both raw PCM formats close the connection with 1007. mp3 costs
 * one decodeAudioData call per unit, which the prefetch pipeline absorbs.
 */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export interface EdgeWordBoundary {
	offsetMs: number;
	durationMs: number;
	text: string;
}

export interface EdgeSynthesisResult {
	audio: Uint8Array;
	boundaries: EdgeWordBoundary[];
}

export class EdgeSocketError extends Error {
	readonly closeCode: number | null;
	constructor(message: string, closeCode: number | null = null) {
		super(message);
		this.name = 'EdgeSocketError';
		this.closeCode = closeCode;
	}
}

/** The subset of WebSocket this module uses, so tests can drive it without a network. */
export interface WebSocketLike {
	binaryType: string;
	readyState: number;
	addEventListener(type: string, listener: (event: never) => void): void;
	send(data: string): void;
	close(): void;
}

export interface EdgeSocketDependencies {
	createSocket(url: string): WebSocketLike;
	now(): number;
	requestId(): string;
}

type Pending = {
	audio: Uint8Array[];
	boundaries: EdgeWordBoundary[];
	resolve(result: EdgeSynthesisResult): void;
	reject(error: unknown): void;
};

/**
 * One connection per reading session, reopened when Microsoft drops it for idleness. Requests are
 * sequential: the caller is the synthesis arbiter, which already serialises them.
 */
export class EdgeSocket {
	private readonly deps: EdgeSocketDependencies;
	private socket: WebSocketLike | null = null;
	private opening: Promise<WebSocketLike> | null = null;
	private pending: Pending | null = null;

	constructor(deps: EdgeSocketDependencies) {
		this.deps = deps;
	}

	async synthesize(ssml: string): Promise<EdgeSynthesisResult> {
		const socket = await this.connect();
		return await new Promise<EdgeSynthesisResult>((resolve, reject) => {
			this.pending = { audio: [], boundaries: [], resolve, reject };
			socket.send(
				`X-RequestId:${this.deps.requestId()}\r\nContent-Type:application/ssml+xml\r\n` +
					`X-Timestamp:${new Date(this.deps.now()).toString()}Z\r\nPath:ssml\r\n\r\n${ssml}`,
			);
		});
	}

	close(): void {
		this.socket?.close();
		this.socket = null;
		this.opening = null;
	}

	private async connect(): Promise<WebSocketLike> {
		if (this.socket && this.socket.readyState === 1) {
			return this.socket;
		}
		this.opening ??= this.open();
		try {
			return await this.opening;
		} finally {
			this.opening = null;
		}
	}

	private async open(): Promise<WebSocketLike> {
		const gec = await secMsGecToken(this.deps.now());
		const url =
			`${ENDPOINT}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
			`&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${this.deps.requestId()}`;
		const socket = this.deps.createSocket(url);
		socket.binaryType = 'arraybuffer';
		socket.addEventListener('message', (event: MessageEvent) => this.onMessage(event));
		socket.addEventListener('close', (event: CloseEvent) => this.onClose(event));
		socket.addEventListener('error', () => this.fail(new EdgeSocketError('websocket error')));

		await new Promise<void>((resolve, reject) => {
			socket.addEventListener('open', () => resolve());
			socket.addEventListener('close', (event: CloseEvent) =>
				reject(new EdgeSocketError(`handshake rejected`, event.code)),
			);
		});

		socket.send(
			`X-Timestamp:${new Date(this.deps.now()).toString()}\r\nContent-Type:application/json; charset=utf-8\r\n` +
				`Path:speech.config\r\n\r\n${JSON.stringify({
					context: {
						synthesis: {
							audio: {
								metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
								outputFormat: OUTPUT_FORMAT,
							},
						},
					},
				})}`,
		);
		this.socket = socket;
		return socket;
	}

	private onMessage(event: MessageEvent): void {
		const pending = this.pending;
		if (!pending) {
			return;
		}
		if (typeof event.data === 'string') {
			const path = /Path:(\S+)/u.exec(event.data)?.[1] ?? '';
			if (path === 'audio.metadata') {
				const body = JSON.parse(event.data.slice(event.data.indexOf('\r\n\r\n') + 4));
				for (const item of body.Metadata ?? []) {
					if (item.Type === 'WordBoundary') {
						pending.boundaries.push({
							// Offsets arrive in 100-nanosecond ticks.
							offsetMs: item.Data.Offset / 10_000,
							durationMs: item.Data.Duration / 10_000,
							text: item.Data.text?.Text ?? '',
						});
					}
				}
				return;
			}
			if (path === 'turn.end') {
				this.finish();
			}
			return;
		}
		const buffer = event.data as ArrayBuffer;
		const headerLength = new DataView(buffer).getUint16(0);
		const payload = new Uint8Array(buffer, 2 + headerLength);
		if (payload.byteLength > 0) {
			pending.audio.push(payload);
		}
	}

	private finish(): void {
		const pending = this.pending;
		if (!pending) {
			return;
		}
		this.pending = null;
		const total = pending.audio.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		if (total === 0) {
			pending.reject(new EdgeSocketError('turn ended with no audio'));
			return;
		}
		const audio = new Uint8Array(total);
		let offset = 0;
		for (const chunk of pending.audio) {
			audio.set(chunk, offset);
			offset += chunk.byteLength;
		}
		pending.resolve({ audio, boundaries: pending.boundaries });
	}

	private onClose(event: CloseEvent): void {
		this.socket = null;
		this.fail(new EdgeSocketError('connection closed', event.code));
	}

	private fail(error: EdgeSocketError): void {
		const pending = this.pending;
		this.pending = null;
		pending?.reject(error);
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/edge_socket.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/edge/edge_socket.ts tests/unit/edge_socket.test.ts
git commit -m "feat: add edge-tts websocket client"
```

---

### Task 6: Word boundary alignment

**Files:**
- Create: `src/offscreen/edge/word_boundary_alignment.ts`
- Test: `tests/unit/edge_word_boundary_alignment.test.ts`

**Interfaces:**
- Consumes: `EdgeWordBoundary` (Task 5), `WordTimingWindow` from `src/offscreen/word_timing.ts`, `SpeechUnitWordMapEntry` from `src/offscreen/speech_unit.ts`
- Produces: `alignWordBoundaries(wordMap: readonly SpeechUnitWordMapEntry[], boundaries: readonly EdgeWordBoundary[]): WordTimingWindow[] | null`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/edge_word_boundary_alignment.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { alignWordBoundaries } from '../../src/offscreen/edge/word_boundary_alignment.ts';

const wordMap = (...words: string[]) => {
	let cursor = 0;
	return words.map((text) => {
		const entry = { text, start: cursor, end: cursor + text.length };
		cursor = entry.end + 1;
		return entry;
	});
};

test('maps one boundary per word straight through', () => {
	const windows = alignWordBoundaries(wordMap('Testing', 'word'), [
		{ offsetMs: 100, durationMs: 475, text: 'Testing' },
		{ offsetMs: 587.5, durationMs: 237.5, text: 'word' },
	]);
	assert.deepEqual(windows, [
		{ text: 'Testing', wordIndex: 0, startSec: 0.1, endSec: 0.575 },
		{ text: 'word', wordIndex: 1, startSec: 0.5875, endSec: 0.825 },
	]);
});

test('groups several boundaries into one word-map entry', () => {
	const windows = alignWordBoundaries(wordMap('20/05', 'xong'), [
		{ offsetMs: 0, durationMs: 200, text: 'hai' },
		{ offsetMs: 200, durationMs: 200, text: 'mươi' },
		{ offsetMs: 400, durationMs: 100, text: '05' },
		{ offsetMs: 500, durationMs: 100, text: 'xong' },
	]);
	assert.equal(windows?.length, 2);
	assert.equal(windows?.[0].wordIndex, 0);
	assert.equal(windows?.[0].startSec, 0);
	assert.ok(windows !== null && windows[0].endSec >= 0.5, 'the group must span every boundary it absorbed');
	assert.equal(windows?.[1].text, 'xong');
});

test('ignores punctuation and case differences when matching', () => {
	const windows = alignWordBoundaries(wordMap('"Hello,"', 'world!'), [
		{ offsetMs: 0, durationMs: 100, text: 'hello' },
		{ offsetMs: 100, durationMs: 100, text: 'world' },
	]);
	assert.equal(windows?.length, 2);
});

test('returns null when the sequences cannot be aligned', () => {
	assert.equal(
		alignWordBoundaries(wordMap('alpha', 'beta'), [{ offsetMs: 0, durationMs: 100, text: 'gamma' }]),
		null,
	);
});

test('returns null when boundaries run out early', () => {
	assert.equal(
		alignWordBoundaries(wordMap('alpha', 'beta'), [{ offsetMs: 0, durationMs: 100, text: 'alpha' }]),
		null,
	);
});

test('returns null for empty inputs rather than an empty timeline', () => {
	assert.equal(alignWordBoundaries([], [{ offsetMs: 0, durationMs: 1, text: 'x' }]), null);
	assert.equal(alignWordBoundaries(wordMap('alpha'), []), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/edge_word_boundary_alignment.test.ts`
Expected: FAIL — cannot resolve `src/offscreen/edge/word_boundary_alignment.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/offscreen/edge/word_boundary_alignment.ts
import type { SpeechUnitWordMapEntry } from '../speech_unit.ts';
import type { WordTimingWindow } from '../word_timing.ts';
import type { EdgeWordBoundary } from './edge_socket.ts';

/**
 * Comparison form: letters and digits only, lowercased, diacritics kept. Microsoft's tokenizer
 * splits and punctuates differently from `buildPlainWordMap`, so the two agree on letters and
 * nothing else.
 */
function comparable(text: string): string {
	return text.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Real per-word timings for one unit, or null when the two tokenizations cannot be reconciled.
 *
 * Highlighting addresses words by their index into `wordMap`, so every boundary Microsoft reports
 * has to be attributed to exactly one entry. A word map entry like "20/05" corresponds to several
 * spoken boundaries, so boundaries are accumulated until their letters match the entry's. Anything
 * that does not reconcile returns null, and the caller estimates timings instead — a wrong
 * highlight is worse than an approximate one.
 */
export function alignWordBoundaries(
	wordMap: readonly SpeechUnitWordMapEntry[],
	boundaries: readonly EdgeWordBoundary[],
): WordTimingWindow[] | null {
	if (wordMap.length === 0 || boundaries.length === 0) {
		return null;
	}

	const windows: WordTimingWindow[] = [];
	let boundaryIndex = 0;

	for (const [wordIndex, entry] of wordMap.entries()) {
		const target = comparable(entry.text);
		if (target === '') {
			continue;
		}
		let accumulated = '';
		const startBoundary = boundaries[boundaryIndex];
		if (!startBoundary) {
			return null;
		}
		let lastBoundary = startBoundary;
		while (boundaryIndex < boundaries.length && accumulated.length < target.length) {
			lastBoundary = boundaries[boundaryIndex];
			accumulated += comparable(lastBoundary.text);
			boundaryIndex += 1;
		}
		if (accumulated !== target) {
			return null;
		}
		windows.push({
			text: entry.text,
			wordIndex,
			startSec: startBoundary.offsetMs / 1000,
			endSec: (lastBoundary.offsetMs + lastBoundary.durationMs) / 1000,
		});
	}

	// Leftover boundaries mean the unit said more than the word map accounts for; the mapping
	// past that point would be guesswork.
	return boundaryIndex === boundaries.length && windows.length > 0 ? windows : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/edge_word_boundary_alignment.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/edge/word_boundary_alignment.ts tests/unit/edge_word_boundary_alignment.test.ts
git commit -m "feat: align edge-tts word boundaries to the unit word map"
```

---

### Task 7: Provider interface and Supertonic provider

**Files:**
- Create: `src/offscreen/speech_provider.ts`, `src/offscreen/supertonic_provider.ts`
- Test: `tests/unit/supertonic_provider.test.ts`

**Interfaces:**
- Consumes: `synthesizeSpeechUnitSamples` from `src/offscreen/audio.ts`, `Style` from `src/offscreen/supertonic_helper.ts`
- Produces:
  - `SynthesizedUnit { samples: Float32Array; sampleRate: number; wordTimings: WordTimingWindow[] | null }`
  - `SynthesizedPlayback { buffer: AudioBuffer; wordTimings: WordTimingWindow[] | null }`
  - `SpeechProvider { readonly id: 'supertonic' | 'edge'; synthesize(input: SpeechProviderInput): Promise<SynthesizedUnit> }`
  - `SpeechProviderInput { unit: SpeechUnit; lang: string; voiceId: string; speed: number; onRawEngineSamples?: (samples: Float32Array) => void }`
  - `createSupertonicProvider(deps: { engine(): { call(...): Promise<{ wav: Float32Array }>; sampleRate: number }; style(voiceId: string): Promise<Style> }): SpeechProvider`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/supertonic_provider.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupertonicProvider } from '../../src/offscreen/supertonic_provider.ts';

const style = { dp: {} } as never;

function makeProvider(wav = new Float32Array([0.1, -0.1, 0.2])) {
	const calls: unknown[] = [];
	const provider = createSupertonicProvider({
		engine: () => ({
			sampleRate: 44_100,
			async call(text: string, lang: string, usedStyle: unknown, steps: number, speed: number, silence: number) {
				calls.push({ text, lang, usedStyle, steps, speed, silence });
				return { wav };
			},
		}),
		style: async () => style,
	});
	return { provider, calls };
}

test('identifies itself as the supertonic provider', () => {
	assert.equal(makeProvider().provider.id, 'supertonic');
});

test('synthesizes the unit synthesis text and reports the engine sample rate', async () => {
	const { provider, calls } = makeProvider();
	const result = await provider.synthesize({
		unit: { text: '20/05', synthesisText: 'hai mươi tháng năm', pauseAfterMs: 0 },
		lang: 'vi',
		voiceId: 'F1',
		speed: 1.5,
	});
	assert.equal(result.sampleRate, 44_100);
	assert.deepEqual(Array.from(result.samples), [0.1, -0.1, 0.2]);
	assert.equal((calls[0] as { text: string }).text, 'hai mươi tháng năm');
	assert.equal((calls[0] as { speed: number }).speed, 1.5);
});

test('never reports word timings, so the caller estimates them', async () => {
	const { provider } = makeProvider();
	const result = await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: 0 },
		lang: 'en',
		voiceId: 'F1',
		speed: 1,
	});
	assert.equal(result.wordTimings, null);
});

test('renders internal silence for units with no trailing pause', async () => {
	const { provider, calls } = makeProvider();
	await provider.synthesize({ unit: { text: 'hello', pauseAfterMs: null }, lang: 'en', voiceId: 'F1', speed: 1 });
	assert.equal((calls[0] as { silence: number }).silence, 0.3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/supertonic_provider.test.ts`
Expected: FAIL — cannot resolve `src/offscreen/supertonic_provider.ts`

- [ ] **Step 3: Write the interface**

```ts
// src/offscreen/speech_provider.ts
import type { SpeechUnit } from './speech_unit.ts';
import type { WordTimingWindow } from './word_timing.ts';

export interface SpeechProviderInput {
	unit: SpeechUnit;
	lang: string;
	voiceId: string;
	speed: number;
	/** Called with the engine's raw output before verification, for boundary diagnostics. */
	onRawEngineSamples?: (samples: Float32Array) => void;
}

export interface SynthesizedUnit {
	samples: Float32Array;
	sampleRate: number;
	/** null when the provider cannot report timings; the caller estimates them instead. */
	wordTimings: WordTimingWindow[] | null;
}

/** What the coordinator caches: decoded audio plus whatever timings came with it. */
export interface SynthesizedPlayback {
	buffer: AudioBuffer;
	wordTimings: WordTimingWindow[] | null;
}

export interface SpeechProvider {
	readonly id: 'supertonic' | 'edge';
	synthesize(input: SpeechProviderInput): Promise<SynthesizedUnit>;
}
```

- [ ] **Step 4: Write the Supertonic provider**

```ts
// src/offscreen/supertonic_provider.ts
import { synthesizeSpeechUnitSamples } from './audio.ts';
import type { SpeechProvider, SpeechProviderInput, SynthesizedUnit } from './speech_provider.ts';
import type { Style } from './supertonic_helper.ts';

interface SupertonicEngine {
	sampleRate: number;
	call(
		text: string,
		lang: string,
		style: Style,
		steps: number,
		speed: number,
		silenceDuration: number,
	): Promise<{ wav: Float32Array }>;
}

export interface SupertonicProviderDependencies {
	engine(): SupertonicEngine;
	style(voiceId: string): Promise<Style>;
}

/**
 * The on-device path, unchanged in behaviour — it only moved behind the provider interface.
 * It has no notion of word timings: asking the duration model for them costs one padded batch
 * per word, which stalled playback at every unit boundary (see word_timing.ts).
 */
export function createSupertonicProvider(deps: SupertonicProviderDependencies): SpeechProvider {
	return {
		id: 'supertonic',
		async synthesize(input: SpeechProviderInput): Promise<SynthesizedUnit> {
			const engine = deps.engine();
			const style = await deps.style(input.voiceId);
			const samples = await synthesizeSpeechUnitSamples(
				input.unit,
				input.lang,
				input.speed,
				async (text, lang, steps, speed, silenceDuration) =>
					(await engine.call(text, lang, style, steps, speed, silenceDuration)).wav,
				{ unitText: input.unit.text },
				input.onRawEngineSamples,
			);
			return { samples, sampleRate: engine.sampleRate, wordTimings: null };
		},
	};
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/supertonic_provider.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 6: Run the whole unit suite to confirm nothing regressed**

Run: `bun test tests/unit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/offscreen/speech_provider.ts src/offscreen/supertonic_provider.ts tests/unit/supertonic_provider.test.ts
git commit -m "feat: introduce the SpeechProvider boundary with a Supertonic implementation"
```

---

### Task 8: Edge provider

**Files:**
- Create: `src/offscreen/edge/edge_provider.ts`
- Test: `tests/unit/edge_provider.test.ts`

**Interfaces:**
- Consumes: `EdgeSocket`, `EdgeSynthesisResult` (Task 5), `buildSsml` (Task 4), `localeForLanguage` from `src/shared/edge_voices.ts` (Task 3), `alignWordBoundaries` (Task 6), `SpeechProvider` (Task 7)
- Produces: `createEdgeProvider(deps: EdgeProviderDependencies): SpeechProvider`, `EdgeProviderDependencies { socket: { synthesize(ssml: string): Promise<EdgeSynthesisResult> }; decode(audio: Uint8Array): Promise<{ samples: Float32Array; sampleRate: number }> }`, `EdgeUnsupportedLanguageError`

Decoding is injected because `decodeAudioData` needs a real `AudioContext`, which unit tests do not have.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/edge_provider.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createEdgeProvider, EdgeUnsupportedLanguageError } from '../../src/offscreen/edge/edge_provider.ts';

function makeProvider(boundaries = [{ offsetMs: 0, durationMs: 500, text: 'hello' }]) {
	const sent: string[] = [];
	const provider = createEdgeProvider({
		socket: {
			async synthesize(ssml: string) {
				sent.push(ssml);
				return { audio: new Uint8Array([1, 2, 3]), boundaries };
			},
		},
		decode: async () => ({ samples: new Float32Array([0.5, -0.5]), sampleRate: 24_000 }),
	});
	return { provider, sent };
}

test('identifies itself as the edge provider', () => {
	assert.equal(makeProvider().provider.id, 'edge');
});

test('sends ssml built from the unit canonical text, not the normalized text', async () => {
	const { provider, sent } = makeProvider([{ offsetMs: 0, durationMs: 300, text: '20/05' }]);
	await provider.synthesize({
		unit: { text: '20/05', synthesisText: 'hai mươi tháng năm', pauseAfterMs: 0, wordMap: [{ text: '20/05', start: 0, end: 5 }] },
		lang: 'vi',
		voiceId: 'vi-VN-HoaiMyNeural',
		speed: 1.5,
	});
	assert.match(sent[0], />20\/05</u);
	assert.doesNotMatch(sent[0], /hai mươi/u);
	assert.match(sent[0], /rate='\+50%'/u);
	assert.match(sent[0], /xml:lang='vi-VN'/u);
});

test('returns decoded samples with the decoder sample rate', async () => {
	const { provider } = makeProvider();
	const result = await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: 0, wordMap: [{ text: 'hello', start: 0, end: 5 }] },
		lang: 'en',
		voiceId: 'en-US-AvaNeural',
		speed: 1,
	});
	assert.deepEqual(Array.from(result.samples), [0.5, -0.5]);
	assert.equal(result.sampleRate, 24_000);
});

test('reports aligned word timings when the boundaries reconcile', async () => {
	const { provider } = makeProvider();
	const result = await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: 0, wordMap: [{ text: 'hello', start: 0, end: 5 }] },
		lang: 'en',
		voiceId: 'en-US-AvaNeural',
		speed: 1,
	});
	assert.deepEqual(result.wordTimings, [{ text: 'hello', wordIndex: 0, startSec: 0, endSec: 0.5 }]);
});

test('falls back to null timings when the boundaries cannot be aligned', async () => {
	const { provider } = makeProvider([{ offsetMs: 0, durationMs: 500, text: 'goodbye' }]);
	const result = await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: 0, wordMap: [{ text: 'hello', start: 0, end: 5 }] },
		lang: 'en',
		voiceId: 'en-US-AvaNeural',
		speed: 1,
	});
	assert.equal(result.wordTimings, null);
});

test('rejects a language Microsoft has no voices for', async () => {
	const { provider } = makeProvider();
	await assert.rejects(
		provider.synthesize({ unit: { text: 'hello', pauseAfterMs: 0 }, lang: 'na', voiceId: 'x', speed: 1 }),
		EdgeUnsupportedLanguageError,
	);
});

test('requests a trailing break for units with no pause', async () => {
	const { provider, sent } = makeProvider();
	await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: null, wordMap: [{ text: 'hello', start: 0, end: 5 }] },
		lang: 'en',
		voiceId: 'en-US-AvaNeural',
		speed: 1,
	});
	assert.match(sent[0], /<break time='300ms'\/>/u);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/edge_provider.test.ts`
Expected: FAIL — cannot resolve `src/offscreen/edge/edge_provider.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/offscreen/edge/edge_provider.ts
import type { SpeechProvider, SpeechProviderInput, SynthesizedUnit } from '../speech_provider.ts';
import type { EdgeSynthesisResult } from './edge_socket.ts';
import { buildSsml } from './edge_ssml.ts';
import { localeForLanguage } from '../../shared/edge_voices.ts';
import { alignWordBoundaries } from './word_boundary_alignment.ts';

/** Matches the internal silence Supertonic renders for units with no trailing pause. */
const INTERNAL_SILENCE_MS = 300;

export class EdgeUnsupportedLanguageError extends Error {
	constructor(lang: string) {
		super(`edge-tts has no voices for language ${lang}`);
		this.name = 'EdgeUnsupportedLanguageError';
	}
}

export interface EdgeProviderDependencies {
	socket: { synthesize(ssml: string): Promise<EdgeSynthesisResult> };
	/** Injected because decodeAudioData needs a real AudioContext. */
	decode(audio: Uint8Array): Promise<{ samples: Float32Array; sampleRate: number }>;
}

/**
 * The cloud path. It speaks `unit.text`, never `unit.synthesisText`: the normalizer exists to
 * make Supertonic pronounce numbers and dates correctly, and Microsoft's own frontend already
 * does that job — running both would expand the same string twice.
 */
export function createEdgeProvider(deps: EdgeProviderDependencies): SpeechProvider {
	return {
		id: 'edge',
		async synthesize(input: SpeechProviderInput): Promise<SynthesizedUnit> {
			const locale = localeForLanguage(input.lang);
			if (locale === null) {
				throw new EdgeUnsupportedLanguageError(input.lang);
			}
			const ssml = buildSsml({
				text: input.unit.text,
				voice: input.voiceId,
				locale,
				speed: input.speed,
				internalSilenceMs: input.unit.pauseAfterMs === null ? INTERNAL_SILENCE_MS : 0,
			});
			const { audio, boundaries } = await deps.socket.synthesize(ssml);
			const { samples, sampleRate } = await deps.decode(audio);
			input.onRawEngineSamples?.(samples);
			return {
				samples,
				sampleRate,
				wordTimings: alignWordBoundaries(input.unit.wordMap ?? [], boundaries),
			};
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/edge_provider.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/edge/edge_provider.ts tests/unit/edge_provider.test.ts
git commit -m "feat: add the edge-tts speech provider"
```

---

### Task 9: Wire providers into the offscreen playback path

**Files:**
- Modify: `src/offscreen/offscreen.ts` (`synthesizeUnit` at :363, `SynthesisInput` at :434, arbiter and coordinator at :443-447, word timing at :802)
- Modify: `src/offscreen/audio_export_engine.ts` (`synthesize` in `AudioExportEngineDependencies` at :34)
- Test: `tests/unit/audio_export_engine.test.ts` (update the fake `synthesize` to the new return shape)

**Interfaces:**
- Consumes: `SpeechProvider`, `SynthesizedPlayback` (Task 7), `createSupertonicProvider` (Task 7), `createEdgeProvider` (Task 8), `EdgeSocket` (Task 5)
- Produces: `activeProvider(): SpeechProvider` and a coordinator whose output is `SynthesizedPlayback`

- [ ] **Step 1: Change the coordinator and arbiter output type**

In `offscreen.ts`, replace the `AudioBuffer` type argument with `SynthesizedPlayback`:

```ts
const synthesisArbiter = new SynthesisArbiter<SynthesisInput, SynthesizedPlayback>(({ unit, lang, voiceId, speed, owner, probeId }) =>
	synthesizeUnit(unit, lang, voiceId, speed, owner, probeId),
);

const synthesisCoordinator = new IndexedSynthesisCoordinator<SynthesisInput, SynthesizedPlayback>(
	(input) => synthesisArbiter.foreground(input),
	{ onResolved: () => notifyExportRunway() },
);
```

`SynthesisInput` loses `style: Style` and gains `voiceId: string`.

- [ ] **Step 2: Rewrite `synthesizeUnit` to delegate to the active provider**

```ts
async function synthesizeUnit(
	unit: SpeechUnit,
	lang: string,
	voiceId: string,
	speed: number,
	owner: SynthesisOwner,
	probeId: string | null = currentExtensionSessionId,
): Promise<SynthesizedPlayback> {
	const provider = activeProvider();
	const synthesisStartedAtMs = performance.now();
	if (!audioCtx) {
		audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
	}
	const inferStartedAtMs = performance.now();
	const synthesisIndex = unit.synthesisIndex ?? speechUnits.indexOf(unit);
	const unitIndex = synthesisIndex >= 0 ? synthesisIndex : null;
	let synthesized: SynthesizedUnit;
	try {
		synthesized = await provider.synthesize({
			unit,
			lang,
			voiceId,
			speed,
			onRawEngineSamples: (samples) =>
				engineBoundaryDiagnostics.record({
					probeId,
					unitIndex,
					owner: owner === 'playback' ? 'foreground' : 'export',
					canonicalText: unit.text,
					synthesisText: unit.synthesisText ?? unit.text,
					language: lang,
					requestedSpeed: speed,
					samples,
				}),
		});
	} catch (error) {
		if (owner === 'export') {
			lastExportProbeFailure = {
				name: error instanceof Error ? error.name : 'UnknownError',
				reason: error instanceof VoicedAudioError ? error.reason : null,
			};
		}
		throw error;
	}
	if (owner === 'playback') {
		playbackMetrics.recordInferDuration(performance.now() - inferStartedAtMs);
	}

	const buffer = createSpeechAudioBuffer(audioCtx, synthesized.samples, synthesized.sampleRate, unit.pauseAfterMs ?? 0);
	if (owner === 'playback') {
		const synthesisMilliseconds = performance.now() - synthesisStartedAtMs;
		playbackMetrics.recordSynthDuration(synthesisMilliseconds);
		recentSynthesisMilliseconds.push(synthesisMilliseconds);
		if (recentSynthesisMilliseconds.length > 5) {
			recentSynthesisMilliseconds.shift();
		}
	}
	return { buffer, wordTimings: synthesized.wordTimings };
}
```

Note the `forceNextExportRawFailure` test hook that lived inside the old inline synthesis callback moves into the `SupertonicProvider` construction site in the next step, so export failure-injection tests keep working.

- [ ] **Step 3: Construct both providers and select between them**

```ts
let edgeSocket: EdgeSocket | null = null;
let sessionProviderId: 'edge' | 'supertonic' = 'edge';

const supertonicProvider = createSupertonicProvider({
	engine: () => {
		if (!ttsEngine) {
			throw new Error('TTS Engine is not initialized');
		}
		return ttsEngine;
	},
	style: (voiceId) => getVoiceStyle(voiceId),
});

function edgeProvider(): SpeechProvider {
	edgeSocket ??= new EdgeSocket({
		createSocket: (url) => new WebSocket(url),
		now: () => Date.now(),
		requestId: () => crypto.randomUUID().replaceAll('-', ''),
	});
	return createEdgeProvider({
		socket: edgeSocket,
		decode: async (audio) => {
			const context = audioCtx ?? new AudioContext();
			// decodeAudioData detaches its input, so hand it a copy of the socket's bytes.
			const decoded = await context.decodeAudioData(audio.slice().buffer);
			return { samples: decoded.getChannelData(0), sampleRate: decoded.sampleRate };
		},
	});
}

function activeProvider(): SpeechProvider {
	return sessionProviderId === 'edge' ? edgeProvider() : supertonicProvider;
}
```

- [ ] **Step 4: Prefer real word timings at playback**

At `offscreen.ts:802`, the buffer now arrives as a `SynthesizedPlayback`. Replace the timing computation with:

```ts
const windows =
	playback.wordTimings ??
	computeReadableSurfaceWordTimings(currentReadableSurface, unit?.wordMap ?? [], spokenDurationSec);
```

Real timings are already per-word for this unit; the estimate remains for Supertonic and for unalignable units. Keep respecting `currentReadableSurface === 'none'` by guarding: when the surface is `'none'`, use `[]` regardless of provider.

- [ ] **Step 5: Skip the normalizer when the session runs on edge**

At the `preparePlaybackUnits` call site (`offscreen.ts:1366`), the normalizer argument becomes conditional on the session provider:

```ts
const units = await preparePlaybackUnits(
	rawText,
	lang,
	sessionProviderId === 'edge' ? null : vietnameseNormalizer,
	data.pronunciationRules ?? [],
);
```

`sessionProviderId` is read from storage via `readTtsProvider()` when the session starts, before this call. Passing `null` takes the branch at `playback_preparation.ts:71`, which plans from the source paragraphs and still applies the pronunciation dictionary — the normalizer is a step of the Supertonic flow only.

- [ ] **Step 6: Update the export engine's synthesize dependency**

In `audio_export_engine.ts`, the injected `synthesize` returns `SynthesizedPlayback`; the engine uses `.buffer` and ignores timings. Update the type and the single call site, then update the fake in `tests/unit/audio_export_engine.test.ts` to return `{ buffer, wordTimings: null }`.

- [ ] **Step 7: Run the full unit suite**

Run: `bun test tests/unit`
Expected: PASS. `tests/unit/audio_export_engine.test.ts` and `tests/unit/export_snapshot_diagnostics.test.ts` are the ones most likely to need the shape update.

- [ ] **Step 8: Typecheck and build**

Run: `bun run build:chrome`
Expected: `tsc` clean, build succeeds

- [ ] **Step 9: Commit**

```bash
git add src/offscreen/offscreen.ts src/offscreen/audio_export_engine.ts tests/unit/audio_export_engine.test.ts
git commit -m "feat: route offscreen synthesis through the provider boundary"
```

---

### Task 10: Manifest, DNR rule, and manifest validation

**Files:**
- Create: `public/rules.json`
- Modify: `public/manifest.json`, `scripts/validate-free-manifest.mjs`, `rsbuild.config.ts`

**Interfaces:**
- Produces: a `declarative_net_request` ruleset named `edge_tts_ua` that rewrites `user-agent` for WebSocket requests to `speech.platform.bing.com`

- [ ] **Step 1: Write the rule file**

```json
[
	{
		"id": 1,
		"priority": 1,
		"action": {
			"type": "modifyHeaders",
			"requestHeaders": [
				{
					"header": "user-agent",
					"operation": "set",
					"value": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"
				}
			]
		},
		"condition": {
			"urlFilter": "speech.platform.bing.com",
			"resourceTypes": ["websocket"]
		}
	}
]
```

- [ ] **Step 2: Extend the manifest**

In `public/manifest.json`: add `"declarativeNetRequestWithHostAccess"` to `permissions`; add `"https://speech.platform.bing.com/*"` and `"wss://speech.platform.bing.com/*"` to `host_permissions`; add

```json
"declarative_net_request": {
	"rule_resources": [{ "id": "edge_tts_ua", "enabled": true, "path": "rules.json" }]
}
```

- [ ] **Step 3: Update the manifest validator**

In `scripts/validate-free-manifest.mjs`, add `'declarativeNetRequestWithHostAccess'` to `CHROME_PERMISSIONS` and both Bing hosts to `CHROME_HOST_PERMISSIONS`. For the Firefox lists, follow the Task 1 outcome: include them only if the probe showed Firefox can reach the endpoint.

- [ ] **Step 4: Handle the Firefox branch in the build**

In `rsbuild.config.ts`, the Firefox transform already filters `permissions` and `host_permissions`. Per the Task 1 result, either leave the edge entries in place or strip `declarativeNetRequestWithHostAccess`, the Bing hosts, and the `declarative_net_request` key for Firefox.

- [ ] **Step 5: Build both targets and validate**

```bash
bun run build
bun run validate:manifest:chrome
bun run validate:manifest:firefox
bun run validate:firefox
```
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add public/rules.json public/manifest.json scripts/validate-free-manifest.mjs rsbuild.config.ts
git commit -m "feat: grant the edge-tts host access and User-Agent rewrite rule"
```

---

### Task 11: Provider and voice settings

**Files:**
- Modify: `src/shared/constants.ts`, `src/shared/components/SettingsCard.tsx`, `src/settings/SettingsApp.tsx`, `src/popup/App.tsx`, `src/sidepanel/App.tsx`
- Test: `tests/unit/edge_voice_preferences.test.ts`
- Create: `src/shared/edge_voice_preferences.ts`

**Interfaces:**
- Consumes: `voicesForLanguage`, `defaultVoiceForLanguage`, `isEdgeSupportedLanguage` (Task 3), `browserStorage` from `src/shared/storage.ts`
- Produces: `STORAGE_KEYS.TTS_PROVIDER`, `STORAGE_KEYS.EDGE_VOICES`, `readTtsProvider(): Promise<'edge' | 'supertonic'>`, `readEdgeVoice(lang: string): Promise<string | null>`, `writeEdgeVoice(lang: string, voiceId: string): Promise<void>`, `resolveEdgeVoice(stored: Record<string, string>, lang: string): string | null`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/edge_voice_preferences.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEdgeVoice } from '../../src/shared/edge_voice_preferences.ts';

test('uses the stored voice for that language', () => {
	assert.equal(resolveEdgeVoice({ vi: 'vi-VN-NamMinhNeural' }, 'vi'), 'vi-VN-NamMinhNeural');
});

test('falls back to the language default when nothing is stored', () => {
	assert.equal(resolveEdgeVoice({}, 'vi'), 'vi-VN-HoaiMyNeural');
});

test('ignores a stored voice that does not belong to the language', () => {
	assert.equal(resolveEdgeVoice({ vi: 'en-US-AvaNeural' }, 'vi'), 'vi-VN-HoaiMyNeural');
});

test('returns null for a language edge-tts cannot speak', () => {
	assert.equal(resolveEdgeVoice({}, 'na'), null);
});

test('keys preferences by base language, not by regional variant', () => {
	assert.equal(resolveEdgeVoice({ en: 'en-US-AndrewNeural' }, 'en-GB'), 'en-US-AndrewNeural');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/edge_voice_preferences.test.ts`
Expected: FAIL — cannot resolve `src/shared/edge_voice_preferences.ts`

- [ ] **Step 3: Add the storage keys**

In `src/shared/constants.ts`, inside `STORAGE_KEYS`:

```ts
	TTS_PROVIDER: 'readit_tts_provider',
	EDGE_VOICES: 'readit_edge_voices',
```

- [ ] **Step 4: Write the preference module**

```ts
// src/shared/edge_voice_preferences.ts
import { defaultVoiceForLanguage, voicesForLanguage } from './edge_voices.ts';
import { STORAGE_KEYS } from './constants.ts';
import { browserStorage } from './storage.ts';

export type TtsProviderId = 'edge' | 'supertonic';

/** Preferences are keyed by base language so en-GB and en-US share one choice. */
function preferenceKey(lang: string): string {
	return lang.trim().replaceAll('_', '-').toLowerCase().split('-')[0];
}

/**
 * The voice to speak this language with: the stored choice when it still belongs to the
 * language, otherwise the language's default, otherwise null when edge-tts cannot speak it.
 */
export function resolveEdgeVoice(stored: Record<string, string>, lang: string): string | null {
	const available = voicesForLanguage(lang);
	if (available.length === 0) {
		return null;
	}
	const preferred = stored[preferenceKey(lang)];
	return available.some((voice) => voice.shortName === preferred) ? preferred : defaultVoiceForLanguage(lang);
}

export async function readTtsProvider(): Promise<TtsProviderId> {
	const stored = await browserStorage.get(STORAGE_KEYS.TTS_PROVIDER);
	return stored[STORAGE_KEYS.TTS_PROVIDER] === 'supertonic' ? 'supertonic' : 'edge';
}

export async function readEdgeVoice(lang: string): Promise<string | null> {
	const stored = await browserStorage.get(STORAGE_KEYS.EDGE_VOICES);
	return resolveEdgeVoice((stored[STORAGE_KEYS.EDGE_VOICES] as Record<string, string>) ?? {}, lang);
}

export async function writeEdgeVoice(lang: string, voiceId: string): Promise<void> {
	const stored = await browserStorage.get(STORAGE_KEYS.EDGE_VOICES);
	const voices = { ...((stored[STORAGE_KEYS.EDGE_VOICES] as Record<string, string>) ?? {}) };
	voices[preferenceKey(lang)] = voiceId;
	await browserStorage.set({ [STORAGE_KEYS.EDGE_VOICES]: voices });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/edge_voice_preferences.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 6: Extend the settings UI**

Add to `SettingsCardProps`: `ttsProvider: TtsProviderId`, `contentLang: string`, `edgeVoiceId: string | null`, `onTtsProviderChange(provider: TtsProviderId): void`, `onEdgeVoiceChange(voiceId: string): void`.

Render a provider `<select>` with two options, labelled through `t()` like every other control. The existing voice `<select>` switches its option list by provider:

```tsx
{ttsProvider === 'edge'
	? voicesForLanguage(contentLang).map((voice) => (
			<option key={voice.shortName} value={voice.shortName}>
				{voice.gender === 'male' ? '♂️' : '♀️'} {voice.friendlyName}
			</option>
		))
	: VOICE_STYLES.map((voiceStyle) => (
			<option key={voiceStyle.id} value={voiceStyle.id}>
				{voiceStyle.gender === 'male' ? '♂️' : '♀️'}{' '}
				{VOICE_STYLE_TRANSLATIONS[uiLang][voiceStyle.id as keyof typeof VOICE_STYLE_TRANSLATIONS.en]}
			</option>
		))}
```

Keep `isVoiceDisabled` applying to both selects — switching engines mid-playback is not supported.

Add the new i18n strings to `src/shared/i18n.ts` for every locale it already carries: a provider label, an "online voices (Microsoft)" option, an "on-device voice" option, and a note that online synthesis sends text to Microsoft.

- [ ] **Step 7: Pass the props from each surface**

`SettingsApp.tsx`, `popup/App.tsx`, and `sidepanel/App.tsx` each render `SettingsCard`. Load the provider and voice through `readTtsProvider` / `readEdgeVoice`, pass `contentLang` from the page info the surface already has (falling back to `uiLang` when unavailable), and persist changes with `browserStorage.set` / `writeEdgeVoice`.

- [ ] **Step 8: Build and check the UI renders**

```bash
bun run build:chrome
```
Then load `dist/chrome` unpacked, open the side panel on a Vietnamese article, and confirm the voice dropdown lists exactly HoaiMy and NamMinh.

- [ ] **Step 9: Commit**

```bash
git add src/shared/constants.ts src/shared/edge_voice_preferences.ts src/shared/components/SettingsCard.tsx src/shared/i18n.ts src/settings/SettingsApp.tsx src/popup/App.tsx src/sidepanel/App.tsx tests/unit/edge_voice_preferences.test.ts
git commit -m "feat: let the reader choose a provider and a per-language edge voice"
```

---

### Task 12: Fallback with Vietnamese re-planning

**Files:**
- Modify: `src/offscreen/playback_preparation.ts`, `src/offscreen/offscreen.ts`
- Test: `tests/unit/provider_fallback.test.ts`

**Interfaces:**
- Consumes: `preparePlaybackUnits` (existing), `EdgeSocketError` (Task 5), `EdgeUnsupportedLanguageError` (Task 8)
- Produces: `replanRemainingUnits(units: readonly SpeechUnit[], fromIndex: number, lang: string, normalizer: VietnameseTextNormalizer | null, rules: readonly PronunciationRule[]): Promise<SpeechUnit[]>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/provider_fallback.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { replanRemainingUnits } from '../../src/offscreen/playback_preparation.ts';

const units = [
	{ text: 'Đã đọc xong câu này.', pauseAfterMs: 0 },
	{ text: 'Ngày 20/05 có sự kiện.', pauseAfterMs: 0 },
	{ text: 'Giá là 15%.', pauseAfterMs: 0 },
];

const normalizer = {
	async normalize(text: string) {
		const normalized = text.replaceAll('20/05', 'hai mươi tháng năm').replaceAll('15%', 'mười lăm phần trăm');
		return { text: normalized, wordMap: [] };
	},
};

test('re-plans only the units after the one still playing', async () => {
	const replanned = await replanRemainingUnits(units, 0, 'vi', normalizer, []);
	const joined = replanned.map((unit) => unit.synthesisText ?? unit.text).join(' ');
	assert.match(joined, /hai mươi tháng năm/u);
	assert.doesNotMatch(joined, /Đã đọc xong câu này/u, 'the already-played unit must not come back');
});

test('runs the normalizer so numbers and dates are spoken correctly', async () => {
	const replanned = await replanRemainingUnits(units, 1, 'vi', normalizer, []);
	const joined = replanned.map((unit) => unit.synthesisText ?? unit.text).join(' ');
	assert.match(joined, /mười lăm phần trăm/u);
});

test('returns an empty list when the last unit is already playing', async () => {
	assert.deepEqual(await replanRemainingUnits(units, 2, 'vi', normalizer, []), []);
});

test('keeps non-Vietnamese content unchanged in count and text', async () => {
	const english = [
		{ text: 'First sentence.', pauseAfterMs: 0 },
		{ text: 'Second sentence.', pauseAfterMs: 0 },
	];
	const replanned = await replanRemainingUnits(english, 0, 'en', null, []);
	assert.equal(replanned.length, 1);
	assert.match(replanned[0].text, /Second sentence/u);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/provider_fallback.test.ts`
Expected: FAIL — `replanRemainingUnits` is not exported

- [ ] **Step 3: Add the re-planning helper**

Append to `src/offscreen/playback_preparation.ts`:

```ts
/**
 * Re-plan everything after `fromIndex` for the Supertonic path.
 *
 * The edge path plans without the normalizer, so its units carry raw "20/05" rather than the
 * spoken expansion. Handing those to Supertonic mid-article would read the rest of the page
 * wrong, which is exactly what the Vietnamese normalization work exists to prevent. The unit
 * still playing is left alone — it is already a decoded buffer.
 */
export async function replanRemainingUnits(
	units: readonly SpeechUnit[],
	fromIndex: number,
	lang: string,
	normalizer: VietnameseTextNormalizer | null,
	pronunciationRules: readonly PronunciationRule[] = [],
): Promise<SpeechUnit[]> {
	const remaining = units.slice(fromIndex + 1);
	if (remaining.length === 0) {
		return [];
	}
	return await preparePlaybackUnits(remaining.map((unit) => unit.text).join('\n\n'), lang, normalizer, pronunciationRules);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/provider_fallback.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Wire the downgrade into playback**

In `offscreen.ts`, wrap the provider call so an edge failure retries once and then downgrades:

```ts
/**
 * One retry, then downgrade for the rest of the session. Retrying per unit turns a flaky
 * network into a silent gap before every sentence, which is worse than switching voice once.
 */
async function synthesizeWithFallback(input: SynthesisInput): Promise<SynthesizedPlayback> {
	try {
		return await synthesizeUnit(input.unit, input.lang, input.voiceId, input.speed, input.owner, input.probeId);
	} catch (error) {
		if (sessionProviderId !== 'edge' || !isEdgeFailure(error)) {
			throw error;
		}
		edgeSocket?.close();
		edgeSocket = null;
		try {
			return await synthesizeUnit(input.unit, input.lang, input.voiceId, input.speed, input.owner, input.probeId);
		} catch (retryError) {
			if (!isEdgeFailure(retryError)) {
				throw retryError;
			}
			await downgradeToSupertonic(input.lang);
			return await synthesizeUnit(input.unit, input.lang, activeVoiceStyleId, input.speed, input.owner, input.probeId);
		}
	}
}

function isEdgeFailure(error: unknown): boolean {
	return error instanceof EdgeSocketError || error instanceof EdgeUnsupportedLanguageError;
}
```

`downgradeToSupertonic(lang)` sets `sessionProviderId = 'supertonic'`, closes the socket, clears the synthesis coordinator of unresolved entries, replaces `speechUnits` from `currentUnitIndex` with `await replanRemainingUnits(...)`, recomputes `totalParagraphs` and `progressPercentage` from the new array length, and posts a status message the UI shows as one line. Use `activeVoiceStyleId` — the stored Supertonic style — as the voice for every subsequent unit.

The arbiter's `run` becomes `synthesizeWithFallback`.

- [ ] **Step 6: Run the full suite and build**

```bash
bun test tests/unit
bun run build:chrome
```
Expected: PASS, clean build

- [ ] **Step 7: Manually verify the downgrade**

Load `dist/chrome` unpacked, start a Vietnamese article, then disable the network mid-article. Expect: playback continues in a Supertonic voice within a couple of units, the UI shows the downgrade line, and dates later in the article are read as words rather than digits.

- [ ] **Step 8: Commit**

```bash
git add src/offscreen/playback_preparation.ts src/offscreen/offscreen.ts tests/unit/provider_fallback.test.ts
git commit -m "feat: fall back to Supertonic and re-plan the remaining Vietnamese text"
```

---

### Task 13: Live-endpoint E2E spec

**Files:**
- Create: `tests/e2e/edge-tts-live.spec.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Write the live spec**

```ts
// tests/e2e/edge-tts-live.spec.ts
// Talks to Microsoft's real endpoint, so it is excluded from the default run and executed by
// hand when confirming the endpoint still answers:
//   bunx playwright test tests/e2e/edge-tts-live.spec.ts --grep "reaches the live edge-tts endpoint"
import { expect, test } from './fixtures';

test('reaches the live edge-tts endpoint and returns audio with word boundaries', async ({ context, extensionId }) => {
	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/src/offscreen/offscreen.html`);

	const result = await page.evaluate(async () => {
		const { EdgeSocket } = await import('/edge_socket.js');
		const socket = new EdgeSocket({
			createSocket: (url: string) => new WebSocket(url),
			now: () => Date.now(),
			requestId: () => crypto.randomUUID().replaceAll('-', ''),
		});
		const ssml =
			`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'>` +
			`<voice name='vi-VN-HoaiMyNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>` +
			`Xin chào, đây là bài kiểm tra.</prosody></voice></speak>`;
		const synthesis = await socket.synthesize(ssml);
		socket.close();
		return { bytes: synthesis.audio.byteLength, words: synthesis.boundaries.length };
	});

	expect(result.bytes).toBeGreaterThan(1000);
	expect(result.words).toBeGreaterThan(3);
});
```

- [ ] **Step 2: Exclude it from the default run**

In `playwright.config.ts`, alongside `AUDIO_LIFECYCLE_TEST`:

```ts
const LIVE_ENDPOINT_TEST = /reaches the live edge-tts endpoint/;
```

and add it to each project's `grepInvert` so `bun run test:e2e` never depends on Microsoft.

- [ ] **Step 3: Verify both paths**

```bash
bun run build:chrome
bun run test:e2e                                          # must not run the live spec
bunx playwright test tests/e2e/edge-tts-live.spec.ts --grep "reaches the live edge-tts endpoint"
```
Expected: the suite passes without the live spec; the live spec passes when run explicitly.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/edge-tts-live.spec.ts playwright.config.ts
git commit -m "test: add an opt-in live edge-tts endpoint check"
```

---

### Task 14: Privacy policy, store disclosure, and product copy

**Files:**
- Modify: `docs/privacy-policy.md`, `description_vi.md`, `description_en.md`, `package.json`, `rsbuild.config.ts`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Rewrite the data-handling section of the privacy policy**

State plainly: with the default online voices, the text of the article being read is sent to Microsoft's speech service to be synthesized; no account or identifier accompanies it; switching the provider to on-device voices in Settings keeps everything local. Do not describe the extension as fully offline anywhere in the file.

- [ ] **Step 2: Declare data collection for Firefox**

In `rsbuild.config.ts`, the Firefox transform writes `browser_specific_settings.data_collection_permissions`. If Task 1 concluded Firefox uses the edge path, declare the text transmission there; if not, leave it unchanged and say why in a comment.

- [ ] **Step 3: Update the product copy**

`description_vi.md`, `description_en.md`, `README.md`, and the `description` field in `package.json` all currently promise local Supertonic synthesis. Rewrite them around: online neural voices in 74 languages by default, on-device Supertonic available and used automatically when offline.

- [ ] **Step 4: Add a CHANGELOG entry**

Follow the existing format; note the new default, the language and voice expansion, and that on-device synthesis remains selectable.

- [ ] **Step 5: Note the Chrome Web Store action**

Add a line to `docs/RELEASING.md`: before publishing this version, update the store listing's data-collection disclosure to declare that text is transmitted to a third-party speech service.

- [ ] **Step 6: Commit**

```bash
git add docs/privacy-policy.md description_vi.md description_en.md README.md package.json rsbuild.config.ts CHANGELOG.md docs/RELEASING.md
git commit -m "docs: disclose that the default voices synthesize in the cloud"
```

- [ ] **Step 7: Refresh the knowledge graph**

```bash
graphify update .
```

---

## Self-Review Notes

Checked against `docs/specs/2026-09-06-edge-tts-provider-design.md`:

- Every spec section maps to a task: spike constraints → Tasks 2, 5, 10; provider boundary → Tasks 7, 8, 9; word timings → Tasks 6, 8, 9; text pipeline → Task 9 Step 5 (the edge path passes `normalizer: null`); fallback → Task 12; settings → Task 11; Firefox → Task 1; privacy → Task 14; testing → distributed plus Task 13.
- Type names are consistent across tasks: `SynthesizedUnit` (provider output) and `SynthesizedPlayback` (coordinator cache entry) are defined once in Task 7 and used unchanged in Tasks 8, 9, and 12.
- The one deliberate ordering constraint: Task 1 must run first, because Tasks 10 and 14 both branch on its result.
