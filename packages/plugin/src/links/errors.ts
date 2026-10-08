import { errorMessage } from "@/shared";
import { StorageRequestError } from "@/storage";

/** A relay refusal in the owner's words; any other error as it came. */
export function linkError(err: unknown): Error {
	if (err instanceof StorageRequestError) {
		return new Error(err.userMessage);
	}
	return err instanceof Error ? err : new Error(errorMessage(err));
}
