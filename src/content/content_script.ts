import { Article } from '../shared/types';
import { extractArticleFromDocument } from './article_extractor';
import { claimContentScriptInitialization } from './content_script_state';

function extractArticle(): Article | null {
	return extractArticleFromDocument(document);
}

if (claimContentScriptInitialization(globalThis as unknown as Record<string, unknown>)) {
	// Listen for messages from background/popup
	chrome.runtime.onMessage.addListener(
		(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
			const msg = message as { action: string };
			if (msg.action === 'EXTRACT_ARTICLE') {
				const article = extractArticle();
				if (article) {
					sendResponse({ success: true, article });
				} else {
					sendResponse({ success: false, error: 'Could not find a readable article on this page.' });
				}
			}
			return true; // Keep message channel open for async response
		},
	);

	// Inject extension info tag for E2E testing
	if (typeof document !== 'undefined' && !document.getElementById('readit-dev-ext-info')) {
		const testDiv = document.createElement('div');
		testDiv.id = 'readit-dev-ext-info';
		testDiv.style.display = 'none';
		testDiv.setAttribute('data-extension-id', chrome.runtime.id);
		document.documentElement.appendChild(testDiv);
	}
}
