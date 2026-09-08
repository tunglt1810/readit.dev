// Talks to Microsoft's real endpoint, so it is excluded from the default run by grepInvert in
// playwright.config.ts and executed by hand when confirming the endpoint still answers:
//   bunx playwright test tests/e2e/edge-tts-live.spec.ts --grep "reaches the live edge-tts endpoint"
//
// The handshake logic is inlined rather than imported from src/offscreen/edge: this test exists to
// prove the *endpoint and its manifest permissions* still work, so it must not depend on how the
// bundle happens to expose modules. If it drifts from edge_socket.ts, the unit tests catch that.
import { expect, test } from './fixtures';

test('reaches the live edge-tts endpoint and returns audio with word boundaries', async ({ context, extensionId }) => {
	const page = await context.newPage();
	// The offscreen document is the only place Chrome applies the declarativeNetRequest
	// User-Agent rewrite to a WebSocket handshake (crbug 1285664).
	await page.goto(`chrome-extension://${extensionId}/src/offscreen/offscreen.html`);

	const result = await page.evaluate(async () => {
		const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
		const ticks = Math.floor((Date.now() / 1000 + 11_644_473_600) * 10_000_000);
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(`${ticks - (ticks % 3_000_000_000)}${TRUSTED_CLIENT_TOKEN}`),
		);
		const gec = Array.from(new Uint8Array(digest))
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')
			.toUpperCase();

		const url =
			`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
			`?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-141.0.3537.57`;

		return await new Promise<{ opened: boolean; bytes: number; words: number; closeCode: number | null }>((resolve) => {
			const socket = new WebSocket(url);
			socket.binaryType = 'arraybuffer';
			const outcome = { opened: false, bytes: 0, words: 0, closeCode: null as number | null };
			const timer = setTimeout(() => resolve(outcome), 20_000);
			const finish = () => {
				clearTimeout(timer);
				resolve(outcome);
			};

			socket.addEventListener('open', () => {
				outcome.opened = true;
				const stamp = new Date().toString();
				socket.send(
					`X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
						JSON.stringify({
							context: {
								synthesis: {
									audio: {
										metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
										outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
									},
								},
							},
						}),
				);
				const ssml =
					`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'>` +
					`<voice name='vi-VN-HoaiMyNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>` +
					`Xin chào, đây là bài kiểm tra.</prosody></voice></speak>`;
				socket.send(
					`X-RequestId:${crypto.randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\n` +
						`X-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n${ssml}`,
				);
			});

			socket.addEventListener('message', (event) => {
				if (typeof event.data === 'string') {
					const path = /Path:(\S+)/u.exec(event.data)?.[1] ?? '';
					if (path === 'audio.metadata') {
						const body = JSON.parse(event.data.slice(event.data.indexOf('\r\n\r\n') + 4));
						outcome.words += (body.Metadata ?? []).filter((item: { Type: string }) => item.Type === 'WordBoundary').length;
					}
					if (path === 'turn.end') {
						socket.close();
						finish();
					}
					return;
				}
				const headerLength = new DataView(event.data as ArrayBuffer).getUint16(0);
				outcome.bytes += (event.data as ArrayBuffer).byteLength - headerLength - 2;
			});

			socket.addEventListener('close', (event) => {
				outcome.closeCode = event.code;
				finish();
			});
		});
	});

	// A 403 from a moved Sec-MS-GEC-Version floor, or a missing User-Agent rewrite, shows up here
	// as an unopened socket closing with 1006.
	expect(result.opened, `socket never opened (close code ${result.closeCode})`).toBe(true);
	expect(result.bytes).toBeGreaterThan(1000);
	expect(result.words).toBeGreaterThan(3);
});

// If Microsoft ever starts accepting <break>, this test fails and the padding in
// edge_provider.ts can be reconsidered. Until then it documents why the padding exists.
test('the live endpoint still rejects a <break> tag', async ({ context, extensionId }) => {
	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/src/offscreen/offscreen.html`);

	const closeCode = await page.evaluate(async () => {
		const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
		const ticks = Math.floor((Date.now() / 1000 + 11_644_473_600) * 10_000_000);
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(`${ticks - (ticks % 3_000_000_000)}${TRUSTED_CLIENT_TOKEN}`),
		);
		const gec = Array.from(new Uint8Array(digest))
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')
			.toUpperCase();

		const url =
			`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
			`?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-141.0.3537.57`;

		return await new Promise<number | null>((resolve) => {
			const socket = new WebSocket(url);
			socket.binaryType = 'arraybuffer';
			const timer = setTimeout(() => resolve(null), 20_000);
			socket.addEventListener('open', () => {
				const stamp = new Date().toString();
				socket.send(
					`X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
						JSON.stringify({
							context: {
								synthesis: {
									audio: {
										metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
										outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
									},
								},
							},
						}),
				);
				const ssml =
					`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'>` +
					`<voice name='vi-VN-HoaiMyNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>` +
					`Xin chào.<break time='300ms'/></prosody></voice></speak>`;
				socket.send(
					`X-RequestId:${crypto.randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\n` +
						`X-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n${ssml}`,
				);
			});
			socket.addEventListener('close', (event) => {
				clearTimeout(timer);
				resolve(event.code);
			});
		});
	});

	expect(closeCode, 'a <break> tag must still be rejected with 1007').toBe(1007);
});
