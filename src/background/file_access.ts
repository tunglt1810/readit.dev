export function checkIsFileSchemeAccessAllowed(): Promise<boolean> {
	return new Promise((resolve) => {
		if (typeof chrome === 'undefined' || !chrome.extension?.isAllowedFileSchemeAccess) {
			resolve(false);
			return;
		}

		let resolved = false;
		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				// An unresponsive permission API cannot prove access is allowed.
				resolve(false);
			}
		}, 1000);

		try {
			chrome.extension.isAllowedFileSchemeAccess((isAllowed?: boolean) => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timer);
					resolve(Boolean(isAllowed));
				}
			});
		} catch {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				resolve(false);
			}
		}
	});
}
