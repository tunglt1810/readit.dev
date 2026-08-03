import { configureAudioHostMessageSender } from '../offscreen/audio_host_messages.ts';
import { configureAudioExportDownload, handleOffscreenMessage } from '../offscreen/offscreen.ts';
import { createDirectMessageSender } from '../shared/direct_message.ts';
import { configureAudioHost, handleBackgroundMessage } from './background.ts';
import { createAudioExportDownloader } from './firefox_audio_export_download.ts';

const firefoxGlobal = globalThis as typeof globalThis & {
	browser?: {
		downloads?: Parameters<typeof createAudioExportDownloader>[0];
		runtime?: { sendMessage(message: unknown): Promise<unknown> };
	};
};

const dispatchToBackground = createDirectMessageSender((message, sender, sendResponse) =>
	handleBackgroundMessage(message, sender as chrome.runtime.MessageSender, sendResponse),
);

function isModelStatusMessage(message: unknown): boolean {
	const action = (message as { action?: unknown } | undefined)?.action;
	return action === 'MODEL_LOADING_PROGRESS' || action === 'MODEL_LOADED' || action === 'MODEL_LOAD_FAILED';
}

async function broadcastToExtensionPages(message: unknown): Promise<void> {
	const runtime = firefoxGlobal.browser?.runtime;
	if (runtime) {
		await runtime.sendMessage(message).catch(() => undefined);
		return;
	}
	await new Promise<void>((resolve) => {
		try {
			chrome.runtime.sendMessage(message, () => resolve());
		} catch {
			resolve();
		}
	});
}

const sendToBackground = async (message: unknown): Promise<unknown> => {
	const response = await dispatchToBackground(message);
	if (isModelStatusMessage(message)) {
		await broadcastToExtensionPages(message);
	}
	return response;
};

const sendToAudioHost = createDirectMessageSender((message, sender, sendResponse) =>
	handleOffscreenMessage(message, sender as chrome.runtime.MessageSender, sendResponse),
);

configureAudioExportDownload(
	createAudioExportDownloader(
		firefoxGlobal.browser?.downloads ?? (chrome.downloads as Parameters<typeof createAudioExportDownloader>[0]),
	),
);
configureAudioHostMessageSender(sendToBackground);
configureAudioHost({
	ensure: async () => undefined,
	close: async () => undefined,
	send: sendToAudioHost,
});
