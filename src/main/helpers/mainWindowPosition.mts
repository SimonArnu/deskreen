type Rectangle = { x: number; y: number; width: number; height: number };

export function mainWindowPosition(
	workArea: Rectangle,
	width: number,
	height: number,
) {
	return {
		x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
		y: workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2)),
	};
}
