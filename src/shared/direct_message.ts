export type DirectMessageResponse = (response?: unknown) => void;

export type DirectMessageListener = (message: unknown, sender: unknown, sendResponse: DirectMessageResponse) => boolean | undefined;

export function createDirectMessageSender(listener: DirectMessageListener, sender: unknown = {}): (message: unknown) => Promise<unknown> {
	return (message) =>
		new Promise((resolve, reject) => {
			let settled = false;
			const respond: DirectMessageResponse = (response) => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(response);
			};

			try {
				const keepChannelOpen = listener(message, sender, respond);
				if (keepChannelOpen !== true && !settled) {
					settled = true;
					resolve(undefined);
				}
			} catch (error) {
				if (!settled) {
					settled = true;
					reject(error);
				}
			}
		});
}
