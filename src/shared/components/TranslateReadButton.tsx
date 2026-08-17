import { translateAndReadLabel } from '../i18n';
import type { TranslationTarget } from '../types';
import { PlaybackIcon } from './PlaybackIcon';

export interface TranslateReadButtonProps {
	target: TranslationTarget;
	onClick: () => void;
}

/**
 * A transport control, sized and shaped like the ones beside it, with the target language engraved
 * into its face. Every other control here has a fixed meaning; this one's is a setting, so the
 * face has to carry the parameter. A rim badge would read as a count, and would sit right beside
 * the export button's progress ring, which is a different circle meaning a different thing.
 */
export function TranslateReadButton({ target, onClick }: TranslateReadButtonProps) {
	const label = translateAndReadLabel(target);

	return (
		<button
			className="btn btn-secondary btn-icon-only btn-translate-read"
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			data-tooltip={label}
		>
			<PlaybackIcon name="translate" />
			<span className="translate-read-target" aria-hidden="true">
				{target}
			</span>
		</button>
	);
}
