export type AudioHostMessageSender = (message: unknown) => Promise<unknown>;

let sendMessage: AudioHostMessageSender = (message) => chrome.runtime.sendMessage(message);

export function configureAudioHostMessageSender(sender: AudioHostMessageSender): void {
	sendMessage = sender;
}

export function emitAudioHostMessage(message: unknown): void {
	void sendMessage(message).catch(() => undefined);
}

export function requestAudioHostMessage(message: unknown): Promise<unknown> {
	return sendMessage(message);
}
