import type { DocumentReaderPortMessage, DocumentReaderSnapshot } from '../shared/document_reader.ts';
import type { ReadableSurfaceInitMessage, ReadableSurfaceUpdateMessage } from '../shared/readable_surface.ts';
import type { PlaybackSessionSnapshot } from '../shared/types.ts';
import { createWordHighlightUpdateCoalescer } from './word_highlight_update_coalescer.ts';

export interface ReadableSurfaceCoordinator {
	activate(session: PlaybackSessionSnapshot): void;
	attachDocumentReader(owner: DocumentReaderOwner): Promise<boolean>;
	detachDocumentReader(tabId: number): Promise<void>;
	documentReaderTabId(): number | null;
	initialize(message: ReadableSurfaceInitMessage): Promise<{ success: boolean }>;
	advance(message: ReadableSurfaceUpdateMessage): void;
	clear(sessionId: string): Promise<void>;
}

export interface DocumentReaderOwner {
	tabId: number;
	sessionId: string;
	deliver(message: DocumentReaderPortMessage): void;
}

interface ReadableSurfaceDependencies {
	sendTabMessage(tabId: number, message: unknown): Promise<unknown>;
	sendRuntimeMessage(message: unknown): Promise<unknown>;
	requestDocumentReaderSnapshot(sessionId: string): Promise<DocumentReaderSnapshot | null>;
	detachDocumentReader(sessionId: string): Promise<void>;
	enqueue(operation: () => Promise<void>): void;
}

export function createReadableSurfaceCoordinator(dependencies: ReadableSurfaceDependencies): ReadableSurfaceCoordinator {
	let activeSession: PlaybackSessionSnapshot | null = null;
	let websiteReady = false;
	let documentReaderOwner: DocumentReaderOwner | null = null;

	const deliverDocumentSnapshot = async (sessionId: string): Promise<boolean> => {
		const owner = documentReaderOwner;
		if (!owner || owner.sessionId !== sessionId) {
			return false;
		}
		const snapshot = await dependencies.requestDocumentReaderSnapshot(sessionId);
		if (!snapshot || activeSession?.sessionId !== sessionId || documentReaderOwner !== owner || snapshot.sessionId !== sessionId) {
			return false;
		}
		try {
			owner.deliver({ action: 'DOCUMENT_READER_SNAPSHOT', snapshot });
			return true;
		} catch {
			documentReaderOwner = null;
			await dependencies.detachDocumentReader(sessionId).catch(() => undefined);
			return false;
		}
	};

	const deliverWebsiteUpdate = async (message: ReadableSurfaceUpdateMessage) => {
		const session = activeSession;
		if (
			!session ||
			session.readableSurface !== 'website-dom' ||
			session.source.kind !== 'tab' ||
			!websiteReady ||
			message.sessionId !== session.sessionId
		) {
			return;
		}
		try {
			await dependencies.sendTabMessage(session.source.tabId, {
				action: 'WORD_HIGHLIGHT_UPDATE',
				sessionId: session.sessionId,
				wordIndex: message.wordIndex,
			});
		} catch {
			websiteReady = false;
		}
	};

	const coalescer = createWordHighlightUpdateCoalescer<ReadableSurfaceUpdateMessage>(
		(operation) => dependencies.enqueue(operation),
		deliverWebsiteUpdate,
	);

	return {
		activate(session) {
			if (activeSession) {
				coalescer.discard(activeSession.sessionId);
			}
			activeSession = session;
			websiteReady = false;
		},
		async attachDocumentReader(owner) {
			const session = activeSession;
			if (
				!session ||
				session.sessionId !== owner.sessionId ||
				session.contentScope !== 'article' ||
				session.source.kind !== 'tab' ||
				session.readableSurface !== 'document-reader'
			) {
				return false;
			}
			documentReaderOwner = owner;
			await deliverDocumentSnapshot(session.sessionId);
			return documentReaderOwner === owner;
		},
		async detachDocumentReader(tabId) {
			const owner = documentReaderOwner;
			if (!owner || owner.tabId !== tabId) {
				return;
			}
			documentReaderOwner = null;
			await dependencies.detachDocumentReader(owner.sessionId).catch(() => undefined);
		},
		documentReaderTabId() {
			return documentReaderOwner?.tabId ?? null;
		},
		async initialize(message) {
			const session = activeSession;
			if (
				!session ||
				message.sessionId !== session.sessionId ||
				message.contentScope !== session.contentScope ||
				session.readableSurface === 'none'
			) {
				return { success: false };
			}
			if (session.readableSurface === 'manual-reader') {
				return { success: session.source.kind === 'manual' };
			}
			if (session.readableSurface === 'document-reader') {
				return { success: await deliverDocumentSnapshot(session.sessionId) };
			}
			if (session.source.kind !== 'tab' || message.contentScope === 'manual') {
				return { success: false };
			}
			try {
				const response = await dependencies.sendTabMessage(session.source.tabId, {
					action: 'WORD_HIGHLIGHT_INIT',
					sessionId: session.sessionId,
					contentScope: message.contentScope,
					words: message.words,
				});
				if (activeSession?.sessionId !== session.sessionId) {
					return { success: false };
				}
				websiteReady = (response as { success?: unknown } | undefined)?.success === true;
				return { success: websiteReady };
			} catch {
				if (activeSession?.sessionId === session.sessionId) {
					websiteReady = false;
				}
				return { success: false };
			}
		},
		advance(message) {
			const session = activeSession;
			if (!session || message.sessionId !== session.sessionId || session.readableSurface === 'none') {
				return;
			}
			if (session.readableSurface === 'website-dom') {
				coalescer.submit(message);
				return;
			}
			if (session.readableSurface === 'document-reader') {
				const owner = documentReaderOwner;
				if (owner?.sessionId !== session.sessionId) {
					return;
				}
				try {
					owner.deliver({
						action: 'DOCUMENT_READER_UPDATE',
						sessionId: session.sessionId,
						wordIndex: message.wordIndex,
					});
				} catch {
					documentReaderOwner = null;
					void dependencies.detachDocumentReader(session.sessionId).catch(() => undefined);
				}
				return;
			}
			if (session.source.kind === 'manual') {
				void dependencies
					.sendRuntimeMessage({
						action: 'MANUAL_WORD_HIGHLIGHT_UPDATE',
						sessionId: session.sessionId,
						word: message.word,
						wordIndex: message.wordIndex,
					})
					.catch(() => undefined);
			}
		},
		async clear(sessionId) {
			const session = activeSession;
			if (!session || session.sessionId !== sessionId) {
				return;
			}
			coalescer.discard(sessionId);
			activeSession = null;
			websiteReady = false;
			try {
				if (session.readableSurface === 'website-dom' && session.source.kind === 'tab') {
					await dependencies.sendTabMessage(session.source.tabId, {
						action: 'WORD_HIGHLIGHT_CLEAR',
						sessionId,
					});
				} else if (session.readableSurface === 'manual-reader' && session.source.kind === 'manual') {
					await dependencies.sendRuntimeMessage({
						action: 'MANUAL_WORD_HIGHLIGHT_CLEAR',
						sessionId,
					});
				} else if (session.readableSurface === 'document-reader') {
					const owner = documentReaderOwner;
					if (owner?.sessionId === sessionId) {
						owner.deliver({ action: 'DOCUMENT_READER_CLEAR', sessionId });
					}
					await dependencies.detachDocumentReader(sessionId);
				}
			} catch {
				// Surface failure never interrupts playback cleanup.
			}
		},
	};
}
