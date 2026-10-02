const MARGIN = 8;

interface Point {
	x: number;
	y: number;
}

interface Size {
	width: number;
	height: number;
}

export function placePopup(click: Point, size: Size, viewport: Size): Point {
	let x = click.x + MARGIN;
	let y = click.y + MARGIN;
	if (x + size.width > viewport.width - MARGIN) {
		x = Math.max(MARGIN, viewport.width - size.width - MARGIN);
	}
	if (y + size.height > viewport.height - MARGIN) {
		y = Math.max(MARGIN, click.y - size.height - MARGIN);
	}
	return { x, y };
}

export function positionPopup(popup: HTMLElement, event: MouseEvent): void {
	Object.assign(popup.style, {
		position: "fixed",
		visibility: "hidden",
		left: "0px",
		top: "0px",
	});
	window.requestAnimationFrame(() => {
		const { x, y } = placePopup(
			{ x: event.clientX, y: event.clientY },
			popup.getBoundingClientRect(),
			{ width: window.innerWidth, height: window.innerHeight },
		);
		Object.assign(popup.style, {
			left: `${x}px`,
			top: `${y}px`,
			visibility: "visible",
		});
	});
}
