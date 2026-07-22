import type { CommandResponse, PlaybackSessionSnapshot, PlaybackStateResponse } from './types.ts';

type MessageListener = (message: unknown) => void;

export interface RuntimeLike {
	sendMessage(message: unknown, callback: (response: unknown) => void): unknown;
	readonly lastError?: { message?: string };
	onMessage: {
		addListener(listener: MessageListener): void;
		removeListener(listener: MessageListener): void;
	};
}

export function sendRuntimeRequest<T>(message: unknown, runtime: RuntimeLike = chrome.runtime): Promise<T> {
	return new Promise((resolve, reject) =>
		runtime.sendMessage(message, (response) => {
			const runtimeError = runtime.lastError;
			if (runtimeError) {
				reject(new Error(runtimeError.message || 'Extension runtime request failed.'));
				return;
			}
			if (response === undefined || response === null) {
				reject(new Error('Extension runtime request returned no response.'));
				return;
			}
			resolve(response as T);
		}),
	);
}

export function requestPlaybackState(runtime: RuntimeLike = chrome.runtime): Promise<PlaybackStateResponse> {
	return sendRuntimeRequest<PlaybackStateResponse>({ action: 'GET_PLAYBACK_STATE' }, runtime).catch(() => ({ session: null }));
}

export function sendPlaybackCommand<T extends CommandResponse = CommandResponse>(
	message: unknown,
	runtime: RuntimeLike = chrome.runtime,
): Promise<T> {
	return sendRuntimeRequest<T>(message, runtime).catch(
		(error: unknown) =>
			({
				success: false,
				error: error instanceof Error ? error.message : String(error),
				transportError: true,
			}) as T,
	);
}

export function subscribePlaybackState(runtime: RuntimeLike, listener: (session: PlaybackSessionSnapshot | null) => void): () => void {
	const messageListener: MessageListener = (message) => {
		if (!message || typeof message !== 'object') {
			return;
		}
		const value = message as { action?: string; session?: PlaybackSessionSnapshot | null };
		if (value.action === 'PLAYBACK_STATE_UPDATE') {
			listener(value.session ?? null);
		}
	};
	runtime.onMessage.addListener(messageListener);
	return () => runtime.onMessage.removeListener(messageListener);
}
