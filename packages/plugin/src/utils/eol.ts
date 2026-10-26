/**
 * Text is compared, merged and edited as LF, or a CRLF file would diff differently per device. A lone CR is a
 * line break too, as CodeMirror reads it.
 */
export function toLf(text: string): string {
	// The regex scans a long note even when it has no CR; `includes` is 20x cheaper.
	return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function eolOf(value: string): "\r\n" | "\n" {
	return value.includes("\r\n") ? "\r\n" : "\n";
}

export function withEolOf(like: string, lf: string): string {
	return eolOf(like) === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}
