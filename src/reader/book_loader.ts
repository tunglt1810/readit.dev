import { sendPlaybackCommand } from '../shared/playback_client.ts';
import type { CommandResponse } from '../shared/types.ts';

export type BookKind = 'epub' | 'pdf';

interface FilePickerWindow {
	showOpenFilePicker?: (options: {
		multiple?: boolean;
		types?: { description: string; accept: Record<string, string[]> }[];
	}) => Promise<FileSystemFileHandle[]>;
}

export function isFileSystemAccessSupported(): boolean {
	return typeof (window as FilePickerWindow).showOpenFilePicker === 'function';
}

export function detectBookKind(fileName: string): BookKind | null {
	const lowered = fileName.toLowerCase();
	if (lowered.endsWith('.epub')) {
		return 'epub';
	}
	return lowered.endsWith('.pdf') ? 'pdf' : null;
}

/** Resolves to null when the user dismisses the native picker. */
export async function pickBookFile(): Promise<FileSystemFileHandle | null> {
	const picker = (window as FilePickerWindow).showOpenFilePicker;
	if (!picker) {
		return null;
	}
	try {
		const [handle] = await picker({
			multiple: false,
			types: [{ description: 'Books', accept: { 'application/epub+zip': ['.epub'], 'application/pdf': ['.pdf'] } }],
		});
		return handle ?? null;
	} catch {
		return null;
	}
}

export function sendReaderContent(payload: { title: string; content: string; lang: string }): Promise<CommandResponse> {
	return sendPlaybackCommand({ action: 'START_READER_CONTENT', payload });
}

interface PermissionCapableHandle {
	queryPermission?: (options: { mode: 'read' }) => Promise<PermissionState>;
	requestPermission?: (options: { mode: 'read' }) => Promise<PermissionState>;
}

/** Safe outside a user gesture, unlike `ensureReadPermission`: it never prompts. */
export async function hasReadPermission(handle: FileSystemFileHandle): Promise<boolean> {
	const permissions = handle as unknown as PermissionCapableHandle;
	return (await permissions.queryPermission?.({ mode: 'read' })) === 'granted';
}

/** Must be called inside a user gesture: Chrome may re-prompt after a browser restart. */
export async function ensureReadPermission(handle: FileSystemFileHandle): Promise<boolean> {
	const permissions = handle as unknown as PermissionCapableHandle;
	if (!permissions.queryPermission || !permissions.requestPermission) {
		return false;
	}
	if ((await permissions.queryPermission({ mode: 'read' })) === 'granted') {
		return true;
	}
	return (await permissions.requestPermission({ mode: 'read' })) === 'granted';
}
