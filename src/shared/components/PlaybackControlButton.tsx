import type { RefObject } from 'react';
import { t } from '../i18n';
import type { PlaybackStatus } from '../types';
import { PlaybackIcon } from './PlaybackIcon';

export interface PlaybackControlButtonProps {
	status: PlaybackStatus;
	onClick: () => void;
	buttonRef?: RefObject<HTMLButtonElement | null>;
}

export function PlaybackControlButton({ status, onClick, buttonRef }: PlaybackControlButtonProps) {
	const isStoppedOrError = status === 'stopped' || status === 'error';
	const label = isStoppedOrError ? t('readPage') : t('stopReading');
	const iconName = isStoppedOrError ? 'read' : 'stop';
	const isActive = !isStoppedOrError;

	return (
		<button
			ref={buttonRef}
			className={`btn btn-primary btn-icon-only btn-read ${isActive ? 'active' : ''}`}
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			data-tooltip={label}
		>
			<PlaybackIcon name={iconName} />
		</button>
	);
}
