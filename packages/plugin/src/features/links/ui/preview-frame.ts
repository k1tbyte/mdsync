const STYLE =
	"body{margin:8px;font:14px/1.5 system-ui,sans-serif}img,svg{max-width:100%}pre{overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #8886;padding:2px 6px}.callout{margin:8px 0;padding:8px;border-radius:6px;background:#8881}";

/** A page that runs nothing and loads only what the link itself would: embedded and https images. */
export function previewDocument(html: string, dark: boolean): string {
	return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'"><style>:root{color-scheme:${dark ? "dark" : "light"}}${STYLE}</style><body>${html}</body>`;
}

/** Shows exactly what would be published, in a frame with every capability off. */
export function renderPreviewFrame(
	parent: HTMLElement,
	html: string,
): HTMLIFrameElement {
	const dark = activeDocument.body.classList.contains("theme-dark");
	return parent.createEl("iframe", {
		attr: {
			sandbox: "",
			srcdoc: previewDocument(html, dark),
			"aria-label": "Preview of the link",
		},
	});
}
