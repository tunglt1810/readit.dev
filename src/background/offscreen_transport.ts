import type { CommandResponse } from '../shared/types.ts';

export type OffscreenCommand = { action: string; payload?: unknown };

export async function sendOffscreenCommand(
	message: OffscreenCommand,
	sendMessage: (message: OffscreenCommand) => Promise<unknown>,
): Promise<CommandResponse> {
	const response = await sendMessage(message);
	if (!response || typeof response !== 'object' || typeof (response as { success?: unknown }).success !== 'boolean') {
		return { success: false };
	}
	return response as CommandResponse;
}
