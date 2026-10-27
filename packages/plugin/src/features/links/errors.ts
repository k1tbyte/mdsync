import { asError } from "@/core/shared";
import { StorageRequestError } from "@/features/storage";

/** A relay refusal in the owner's words; any other error as it came. */
export function linkError(err: unknown): Error {
	if (err instanceof StorageRequestError) {
		return new Error(err.userMessage);
	}
	return asError(err);
}
