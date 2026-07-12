const CONTENT_SCRIPT_INITIALIZED_KEY = '__readitDevContentScriptInitialized';

export function claimContentScriptInitialization(scope: Record<string, unknown>): boolean {
	if (scope[CONTENT_SCRIPT_INITIALIZED_KEY] === true) {
		return false;
	}

	scope[CONTENT_SCRIPT_INITIALIZED_KEY] = true;
	return true;
}
