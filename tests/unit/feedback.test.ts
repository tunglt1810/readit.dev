import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFeedbackUrl } from '../../src/popup/feedback.ts';

test('builds one neutral GitHub Feedback URL with extension version', () => {
	const url = new URL(buildFeedbackUrl('1.0.0'));
	assert.equal(url.origin + url.pathname, 'https://github.com/tunglt1810/readit.dev/issues/new');
	assert.match(url.searchParams.get('body') || '', /Extension version: v1\.0\.0/);
	assert.match(url.searchParams.get('body') || '', /Bug|Feature request/);
});

test('does not accept or include page-derived data', () => {
	const feedbackUrl = decodeURIComponent(buildFeedbackUrl('1.0.0'));
	assert.doesNotMatch(feedbackUrl, /example\.com/);
	assert.doesNotMatch(feedbackUrl, /selected text/i);
	assert.doesNotMatch(feedbackUrl, /page title/i);
});
