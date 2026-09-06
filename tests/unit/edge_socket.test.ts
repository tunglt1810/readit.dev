import assert from 'node:assert/strict';
import test from 'node:test';
import { EdgeSocket, EdgeSocketError, type WebSocketLike } from '../../src/offscreen/edge/edge_socket.ts';

class FakeSocket implements WebSocketLike {
	binaryType = 'blob';
	readyState = 0;
	sent: string[] = [];
	closed = false;
	private readonly listeners = new Map<string, ((event: never) => void)[]>();

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

	text(path: string, body: unknown, requestId = 'abc'): void {
		this.emit('message', { data: `X-RequestId:${requestId}\r\nPath:${path}\r\n\r\n${JSON.stringify(body)}` });
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

class Harness {
	readonly urls: string[] = [];
	readonly sockets: FakeSocket[] = [];
	readonly socket: EdgeSocket;
	private issued = 0;

	constructor(timeouts: { requestTimeoutMs?: number; handshakeTimeoutMs?: number } = {}) {
		this.socket = new EdgeSocket({
			createSocket: (url) => {
				this.urls.push(url);
				const fake = new FakeSocket();
				this.sockets.push(fake);
				return fake;
			},
			now: () => Date.UTC(2026, 8, 6, 12, 0, 0),
			requestId: () => `id-${++this.issued}`,
			...timeouts,
		});
	}

	/** The X-RequestId the socket actually used for its most recent ssml frame. */
	requestIdOf(fake: FakeSocket): string {
		const ssml = fake.sent.filter((frame) => frame.includes('Path:ssml')).at(-1) ?? '';
		return /X-RequestId:(\S+)/u.exec(ssml)?.[1] ?? '';
	}

	/** The connection is created after an await on the GEC digest, so poll rather than guess. */
	async connected(index = 0): Promise<FakeSocket> {
		for (let attempt = 0; attempt < 50 && this.sockets.length <= index; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		const fake = this.sockets[index];
		assert.ok(fake, `expected a socket at index ${index}`);
		fake.open();
		// Let EdgeSocket.open() resume past its open listener and send speech.config + ssml.
		await new Promise((resolve) => setTimeout(resolve, 1));
		return fake;
	}
}

test('sends speech.config then the ssml, and resolves on turn.end', async () => {
	const harness = new Harness();
	const pending = harness.socket.synthesize('<speak/>');
	const fake = await harness.connected();

	assert.equal(fake.sent.length, 2);
	assert.match(fake.sent[0], /Path:speech\.config/u);
	assert.match(fake.sent[0], /audio-24khz-48kbitrate-mono-mp3/u);
	assert.match(fake.sent[0], /"wordBoundaryEnabled":"true"/u);
	assert.match(fake.sent[1], /Path:ssml/u);
	assert.match(fake.sent[1], /X-RequestId:id-\d+/u);

	const requestId = harness.requestIdOf(fake);
	fake.text('turn.start', {}, requestId);
	fake.audio([1, 2, 3]);
	fake.audio([4, 5]);
	fake.text(
		'audio.metadata',
		{ Metadata: [{ Type: 'WordBoundary', Data: { Offset: 1_000_000, Duration: 4_750_000, text: { Text: 'Testing' } } }] },
		requestId,
	);
	fake.text('turn.end', {}, requestId);

	const result = await pending;
	assert.deepEqual(Array.from(result.audio), [1, 2, 3, 4, 5]);
	assert.deepEqual(result.boundaries, [{ offsetMs: 100, durationMs: 475, text: 'Testing' }]);
});

test('includes the GEC token and version in the url', async () => {
	const harness = new Harness();
	const pending = harness.socket.synthesize('<speak/>');
	const fake = await harness.connected();
	fake.text('turn.end', {}, harness.requestIdOf(fake));
	await pending.catch(() => undefined);

	assert.match(harness.urls[0], /Sec-MS-GEC=[0-9A-F]{64}/u);
	assert.match(harness.urls[0], /Sec-MS-GEC-Version=1-1\d\d\./u);
	assert.match(harness.urls[0], /TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4/u);
});

test('rejects with EdgeSocketError when the socket closes before turn.end', async () => {
	const harness = new Harness();
	const pending = harness.socket.synthesize('<speak/>');
	const fake = await harness.connected();
	fake.emit('close', { code: 1006, reason: '' });

	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof EdgeSocketError);
		assert.equal(error.closeCode, 1006);
		return true;
	});
});

test('rejects when turn.end arrives with no audio', async () => {
	const harness = new Harness();
	const pending = harness.socket.synthesize('<speak/>');
	const fake = await harness.connected();
	fake.text('turn.end', {}, harness.requestIdOf(fake));

	await assert.rejects(pending, EdgeSocketError);
});

test('reuses one connection across sequential requests', async () => {
	const harness = new Harness();
	const first = harness.socket.synthesize('<speak>1</speak>');
	const fake = await harness.connected();
	fake.audio([1]);
	fake.text('turn.end', {}, harness.requestIdOf(fake));
	await first;

	const second = harness.socket.synthesize('<speak>2</speak>');
	await new Promise((resolve) => setTimeout(resolve, 1));
	fake.audio([2]);
	fake.text('turn.end', {}, harness.requestIdOf(fake));
	await second;

	assert.equal(harness.urls.length, 1, 'expected the second request to reuse the open socket');
	assert.equal(fake.sent.length, 3, 'speech.config once, then one ssml per request');
});

test('rejects the handshake when the socket closes before opening', async () => {
	const harness = new Harness();
	const pending = harness.socket.synthesize('<speak/>');
	for (let attempt = 0; attempt < 50 && harness.sockets.length === 0; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	harness.sockets[0].emit('close', { code: 1006, reason: '' });

	await assert.rejects(pending, EdgeSocketError);
});

test('gives up on a request the server never answers', async () => {
	const harness = new Harness({ requestTimeoutMs: 40 });
	const pending = harness.socket.synthesize('<speak/>');
	await harness.connected();
	// No turn.end, no close — the shape of a silently dropped request.
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof EdgeSocketError);
		assert.match(error.message, /timed out/u);
		return true;
	});
});

test('gives up on a handshake that never completes', async () => {
	const harness = new Harness({ handshakeTimeoutMs: 40 });
	const pending = harness.socket.synthesize('<speak/>');
	for (let attempt = 0; attempt < 50 && harness.sockets.length === 0; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	// Socket neither opens nor closes.
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof EdgeSocketError);
		assert.match(error.message, /timed out/u);
		return true;
	});
});

test('ignores frames belonging to a request that already ended', async () => {
	const harness = new Harness();
	const first = harness.socket.synthesize('<speak>1</speak>');
	const fake = await harness.connected();
	fake.audio([1, 2]);
	fake.text('turn.end', {}, harness.requestIdOf(fake));
	await first;

	const second = harness.socket.synthesize('<speak>2</speak>');
	await new Promise((resolve) => setTimeout(resolve, 1));
	// A late frame from the finished request must not end the new one.
	fake.text('turn.end', {}, 'stale-request-id');
	fake.audio([9]);
	fake.text('turn.end', {}, harness.requestIdOf(fake));
	const result = await second;
	assert.deepEqual(Array.from(result.audio), [9], 'the second request kept only its own audio');
});
