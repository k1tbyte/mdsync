/**
 * Text is compared, merged and edited live as LF. A CRLF file from another tool
 * would otherwise diff differently on every device and never match its base;
 * a lone CR is a line break too, as CodeMirror reads it.
 */
export function toLf(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

export function eolOf(value: string): "\r\n" | "\n" {
	return value.includes("\r\n") ? "\r\n" : "\n";
}

export function withEolOf(like: string, lf: string): string {
	return eolOf(like) === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}
