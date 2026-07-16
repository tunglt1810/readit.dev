export interface RectLike {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface SizeLike {
	width: number;
	height: number;
}

export interface ButtonPosition {
	left: number;
	top: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function computeSelectionButtonPosition(
	anchor: RectLike,
	viewport: SizeLike,
	button: SizeLike,
	gap = 6,
	margin = 8,
): ButtonPosition {
	let left = anchor.right - button.width;
	let top = anchor.bottom + gap;

	if (left + button.width > viewport.width - margin) {
		left = anchor.left - button.width - gap;
	}
	if (top + button.height > viewport.height - margin) {
		top = anchor.top - button.height - gap;
	}

	const maximumLeft = viewport.width - button.width - margin;
	const maximumTop = viewport.height - button.height - margin;
	const minimumLeft = Math.min(margin, Math.max(0, maximumLeft));
	const minimumTop = Math.min(margin, Math.max(0, maximumTop));

	return {
		left: clamp(left, minimumLeft, Math.max(minimumLeft, maximumLeft)),
		top: clamp(top, minimumTop, Math.max(minimumTop, maximumTop)),
	};
}
