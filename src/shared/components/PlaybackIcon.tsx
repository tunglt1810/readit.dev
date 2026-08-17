export type PlaybackIconName =
	| 'read'
	| 'stop'
	| 'pause'
	| 'resume'
	| 'previous'
	| 'next'
	| 'sidepanel'
	| 'book'
	| 'settings'
	| 'lock'
	| 'coffee'
	| 'chevron'
	| 'download'
	| 'check'
	| 'warning'
	| 'translate';

export function PlaybackIcon({ name }: { name: PlaybackIconName }) {
	const commonProps = {
		viewBox: '0 0 24 24',
		'aria-hidden': true,
		focusable: false,
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: 2,
		strokeLinecap: 'round' as const,
		strokeLinejoin: 'round' as const,
	};

	switch (name) {
		case 'stop':
			return (
				<svg {...commonProps}>
					<rect x="7" y="7" width="10" height="10" rx="1" />
				</svg>
			);
		case 'pause':
			return (
				<svg {...commonProps}>
					<line x1="9" y1="6" x2="9" y2="18" />
					<line x1="15" y1="6" x2="15" y2="18" />
				</svg>
			);
		case 'resume':
			return (
				<svg {...commonProps}>
					<polygon points="8 5 19 12 8 19 8 5" />
				</svg>
			);
		case 'previous':
			return (
				<svg {...commonProps}>
					<polygon points="18 5 8 12 18 19 18 5" />
					<line x1="6" y1="5" x2="6" y2="19" />
				</svg>
			);
		case 'next':
			return (
				<svg {...commonProps}>
					<polygon points="6 5 16 12 6 19 6 5" />
					<line x1="18" y1="5" x2="18" y2="19" />
				</svg>
			);
		case 'sidepanel':
			return (
				<svg {...commonProps} width="16" height="16">
					<rect x="3" y="3" width="18" height="18" rx="2" />
					<line x1="15" y1="3" x2="15" y2="21" />
				</svg>
			);
		case 'book':
			// Two facing pages with a spine, sized to sit beside the side panel icon.
			return (
				<svg {...commonProps} width="16" height="16">
					<path d="M12 6.5C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-13c-4.5 0-6.5.5-8 2Z" />
					<line x1="12" y1="6.5" x2="12" y2="19.5" />
				</svg>
			);
		case 'settings':
			return (
				<svg {...commonProps} width="14" height="14">
					<circle cx="12" cy="12" r="3.2" />
					<path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3" />
				</svg>
			);
		case 'lock':
			return (
				<svg {...commonProps} width="13" height="13">
					<rect x="5" y="11" width="14" height="10" rx="2" />
					<path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
				</svg>
			);
		case 'coffee':
			return (
				<svg {...commonProps} width="13" height="13">
					<path d="M4 9h13v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9Z" />
					<path d="M17 10.5h1.5a2.5 2.5 0 0 1 0 5H17" />
					<path d="M8 3v2.5M12 3v2.5" />
				</svg>
			);
		case 'chevron':
			return (
				<svg {...commonProps} width="12" height="12">
					<path d="m6 9 6 6 6-6" />
				</svg>
			);
		case 'download':
			return (
				<svg {...commonProps}>
					<path d="M12 3v12" />
					<path d="m7 10 5 5 5-5" />
					<path d="M5 21h14" />
				</svg>
			);
		case 'check':
			return (
				<svg {...commonProps}>
					<path d="m5 12 4 4L19 6" />
				</svg>
			);
		case 'warning':
			return (
				<svg {...commonProps}>
					<path d="M12 3 2.8 20h18.4L12 3Z" />
					<path d="M12 9v4" />
					<path d="M12 17h.01" />
				</svg>
			);
		case 'translate':
			// A latin glyph turning into a stroke script: the same shape family as the rest, and it
			// reads as "language" rather than as the globe that means "web page" elsewhere.
			return (
				<svg {...commonProps}>
					<path d="M4 5h9" />
					<path d="M8.5 3v2" />
					<path d="M11 5c0 4.5-2.8 8-7 9.5" />
					<path d="M6 10.5c1.4 2.1 3.4 3.6 5.8 4.3" />
					<path d="m13 21 4.2-9.5L21.5 21" />
					<path d="M14.6 17.6h5.2" />
				</svg>
			);
		default:
			return (
				<svg {...commonProps}>
					<path d="M5 9v6h4l5 4V5L9 9H5z" />
					<path d="M17 9a4 4 0 0 1 0 6" />
				</svg>
			);
	}
}
