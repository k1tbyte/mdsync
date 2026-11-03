import { parseLinkLocation } from "@mdsync/protocol";

import { createApi } from "./link/api";
import { sessionCache } from "./link/cache";
import { browserKeys } from "./link/keys";
import { LinkSession } from "./link/session";
import { createView } from "./view";

const root = document.getElementById("app");
if (root) {
	const link = parseLinkLocation(location.pathname, location.hash);
	let session: LinkSession | null = null;
	const view = createView(root, {
		onPassphrase: (passphrase, remember) =>
			void session?.submit(passphrase, remember),
	});
	if (!link) {
		view.show({ kind: "invalid" });
	} else {
		session = new LinkSession({
			...link,
			api: createApi(),
			cache: sessionCache(),
			keys: browserKeys(),
			show: view.show,
		});
		void session.start();
	}
}
