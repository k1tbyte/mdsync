import { errorMessage } from "./errors";

type DiagnosticsSink = (message: string, details?: readonly string[]) => void;

let sink: DiagnosticsSink | null = null;

/**
 * Connects the sink that surfaces these warnings to the user; the engine, GC and history log run far from any
 * service.
 */
export function setDiagnosticsSink(next: DiagnosticsSink | null): void {
	sink = next;
}

export function reportWarning(
	message: string,
	detail?: unknown,
	details: readonly string[] = [],
): void {
	console.warn(`[mdsync] ${message}`, detail);
	const full =
		detail === undefined ? details : [...details, errorMessage(detail)];
	sink?.(message, full);
}
