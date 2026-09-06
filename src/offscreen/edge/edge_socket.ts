import { SEC_MS_GEC_VERSION, secMsGecToken, TRUSTED_CLIENT_TOKEN } from './gec_token.ts';

const ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

/**
 * Only mp3 and opus are accepted; both raw PCM formats close the connection with 1007. mp3 costs
 * one decodeAudioData call per unit, which the prefetch pipeline absorbs.
 */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/** Metadata offsets and durations arrive in 100-nanosecond ticks. */
const TICKS_PER_MILLISECOND = 10_000;

/**
 * A request the server never answers has to end somehow. Microsoft occasionally accepts a frame
 * and then goes quiet — without a deadline the promise never settles and playback stalls for good,
 * which is worse than falling back. Sized well above the ~700ms a unit normally takes.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** Likewise for a connection that neither opens nor closes. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

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
	addEventListener(type: string, listener: (event: Event) => void): void;
	send(data: string): void;
	close(): void;
}

export interface EdgeSocketDependencies {
	createSocket(url: string): WebSocketLike;
	now(): number;
	requestId(): string;
	requestTimeoutMs?: number;
	handshakeTimeoutMs?: number;
}

interface PendingSynthesis {
	/** Frames carry the id of the request they belong to; anything else is from a finished one. */
	requestId: string;
	audio: Uint8Array[];
	boundaries: EdgeWordBoundary[];
	timer: ReturnType<typeof setTimeout>;
	resolve(result: EdgeSynthesisResult): void;
	reject(error: unknown): void;
}

const OPEN = 1;

/**
 * One connection per reading session, reopened when Microsoft drops it for idleness.
 *
 * Requests are sequential because the caller is the synthesis arbiter, which already serialises
 * them. The connection must be created from a document — opened from the service worker,
 * declarativeNetRequest never rewrites the handshake's User-Agent (crbug 1285664) and Microsoft
 * answers 403.
 */
export class EdgeSocket {
	private readonly deps: EdgeSocketDependencies;
	private socket: WebSocketLike | null = null;
	private opening: Promise<WebSocketLike> | null = null;
	private pending: PendingSynthesis | null = null;

	constructor(deps: EdgeSocketDependencies) {
		this.deps = deps;
	}

	async synthesize(ssml: string): Promise<EdgeSynthesisResult> {
		const socket = await this.connect();
		// A request left over from a previous call can only hang; end it before starting another.
		this.fail(new EdgeSocketError('superseded by a newer request'));
		const requestId = this.deps.requestId();
		return await new Promise<EdgeSynthesisResult>((resolve, reject) => {
			const timer = setTimeout(
				() => this.fail(new EdgeSocketError('synthesis request timed out')),
				this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			);
			this.pending = { requestId, audio: [], boundaries: [], timer, resolve, reject };
			socket.send(
				`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\n` +
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
		if (this.socket && this.socket.readyState === OPEN) {
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
		socket.addEventListener('message', (event) => this.onMessage(event as MessageEvent));
		socket.addEventListener('close', (event) => this.onClose(event as CloseEvent));
		socket.addEventListener('error', () => this.fail(new EdgeSocketError('websocket error')));

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new EdgeSocketError('handshake timed out')),
				this.deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
			);
			socket.addEventListener('open', () => {
				clearTimeout(timer);
				resolve();
			});
			socket.addEventListener('close', (event) => {
				clearTimeout(timer);
				reject(new EdgeSocketError('handshake rejected', (event as CloseEvent).code));
			});
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
			this.onTextFrame(event.data, pending);
			return;
		}
		if (!this.frameBelongsToPending(event.data as ArrayBuffer, pending)) {
			return;
		}
		const buffer = event.data as ArrayBuffer;
		const headerLength = new DataView(buffer).getUint16(0);
		const payload = new Uint8Array(buffer, 2 + headerLength);
		if (payload.byteLength > 0) {
			pending.audio.push(payload);
		}
	}

	/** Binary frames carry their headers, request id included, ahead of the audio payload. */
	private frameBelongsToPending(buffer: ArrayBuffer, pending: PendingSynthesis): boolean {
		const headerLength = new DataView(buffer).getUint16(0);
		const headers = new TextDecoder().decode(new Uint8Array(buffer, 2, headerLength));
		const requestId = /X-RequestId:(\S+)/u.exec(headers)?.[1];
		return requestId === undefined || requestId === pending.requestId;
	}

	private onTextFrame(frame: string, pending: PendingSynthesis): void {
		const requestId = /X-RequestId:(\S+)/u.exec(frame)?.[1];
		if (requestId !== undefined && requestId !== pending.requestId) {
			// A late frame from a request that already ended, most likely after a reconnect.
			return;
		}
		const path = /Path:(\S+)/u.exec(frame)?.[1] ?? '';
		if (path === 'audio.metadata') {
			const body = JSON.parse(frame.slice(frame.indexOf('\r\n\r\n') + 4)) as {
				Metadata?: { Type: string; Data: { Offset: number; Duration: number; text?: { Text?: string } } }[];
			};
			for (const item of body.Metadata ?? []) {
				if (item.Type === 'WordBoundary') {
					pending.boundaries.push({
						offsetMs: item.Data.Offset / TICKS_PER_MILLISECOND,
						durationMs: item.Data.Duration / TICKS_PER_MILLISECOND,
						text: item.Data.text?.Text ?? '',
					});
				}
			}
			return;
		}
		if (path === 'turn.end') {
			this.finish();
		}
	}

	private finish(): void {
		const pending = this.pending;
		if (!pending) {
			return;
		}
		this.pending = null;
		clearTimeout(pending.timer);
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
		if (pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}
}
