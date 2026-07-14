const GITHUB_NEW_ISSUE_URL = 'https://github.com/tunglt1810/readit.dev/issues/new';

export function buildFeedbackUrl(version: string): string {
	const url = new URL(GITHUB_NEW_ISSUE_URL);
	url.searchParams.set(
		'body',
		['## Feedback type', '- [ ] Bug', '- [ ] Feature request', '', '## Description', '', '---', `Extension version: v${version}`].join(
			'\n',
		),
	);
	return url.toString();
}
