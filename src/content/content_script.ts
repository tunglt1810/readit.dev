import { Article } from '../shared/types';
import { extractArticleFromDocument } from './article_extractor';
import { claimContentScriptInitialization } from './content_script_state';
import { extractGoogleDocsArticle } from './google_docs_extractor';
import { installSelectionButton } from './selection_button';
import { installWordHighlight } from './word_highlight';

type ArticleExtractionResponse = { success: true; article: Article } | { success: false; error: string };

function getDocumentLanguage(): string {
	return document.documentElement.lang.trim().toLowerCase().replace('_', '-').split('-')[0] || 'na';
}

async function extractArticle(): Promise<ArticleExtractionResponse> {
	const googleDocsResult = await extractGoogleDocsArticle(
		{
			title: document.title || 'Untitled Article',
			url: document.location.href,
			lang: getDocumentLanguage(),
		},
		globalThis.fetch.bind(globalThis),
	);
	if (googleDocsResult) {
		return googleDocsResult;
	}

	const article = extractArticleFromDocument(document);
	return article ? { success: true, article } : { success: false, error: 'Could not find a readable article on this page.' };
}

if (claimContentScriptInitialization(globalThis as unknown as Record<string, unknown>)) {
	// Listen for messages from background/popup.
	// Only return `true` from a branch that actually calls sendResponse. Chrome keeps the
	// reply channel open for ~30s whenever any listener in this context returns `true`, even
	// for actions it doesn't handle — a stray unconditional `true` here previously stalled
	// every chrome.tabs.sendMessage the background sends to this tab for unrelated actions
	// (e.g. WORD_HIGHLIGHT_UPDATE), serializing behind the same message queue used for
	// PAUSE/RESUME/STOP.
	chrome.runtime.onMessage.addListener(
		(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
			const msg = message as { action: string };
			if (msg.action === 'GET_PAGE_INFO') {
				sendResponse({
					available: true,
					title: document.title,
					url: document.location.href,
					lang: getDocumentLanguage(),
				});
				return true;
			}
			if (msg.action === 'EXTRACT_ARTICLE') {
				void extractArticle().then(
					(response) => sendResponse(response),
					() => sendResponse({ success: false, error: 'Could not find a readable article on this page.' }),
				);
				return true; // Keep message channel open for async response
			}
			return undefined;
		},
	);
	void installSelectionButton();
	installWordHighlight();

	// Inject extension info tag for E2E testing
	if (typeof document !== 'undefined' && !document.getElementById('readit-dev-ext-info')) {
		const testDiv = document.createElement('div');
		testDiv.id = 'readit-dev-ext-info';
		testDiv.style.display = 'none';
		testDiv.setAttribute('data-extension-id', chrome.runtime.id);
		document.documentElement.appendChild(testDiv);
	}
}
