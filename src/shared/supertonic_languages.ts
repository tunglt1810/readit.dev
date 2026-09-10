/**
 * Languages the on-device engine can speak. `na` is its placeholder for "not detected", not a
 * language, so anything offering these as choices must drop it.
 *
 * Kept in a leaf module: the side panel needs this list, and importing the helper would pull the
 * ONNX runtime into the panel bundle.
 */
export const AVAILABLE_LANGS = [
	'en',
	'ko',
	'ja',
	'ar',
	'bg',
	'cs',
	'da',
	'de',
	'el',
	'es',
	'et',
	'fi',
	'fr',
	'hi',
	'hr',
	'hu',
	'id',
	'it',
	'lt',
	'lv',
	'nl',
	'pl',
	'pt',
	'ro',
	'ru',
	'sk',
	'sl',
	'sv',
	'tr',
	'uk',
	'vi',
	'na',
];
