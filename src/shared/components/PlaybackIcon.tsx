export type PlaybackIconName = 'read' | 'stop' | 'pause' | 'resume' | 'sidepanel' | 'download' | 'check' | 'warning';

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
		case 'sidepanel':
			return (
				<svg {...commonProps} width="16" height="16">
					<rect x="3" y="3" width="18" height="18" rx="2" />
					<line x1="15" y1="3" x2="15" y2="21" />
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
		default:
			return (
				<svg {...commonProps}>
					<path d="M5 9v6h4l5 4V5L9 9H5z" />
					<path d="M17 9a4 4 0 0 1 0 6" />
				</svg>
			);
	}
}
