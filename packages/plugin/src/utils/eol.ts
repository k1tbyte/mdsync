/**
 * Text is compared, merged and edited as LF, or a CRLF file would diff differently per device. A lone CR is a
 * line break too, as CodeMirror reads it.
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
