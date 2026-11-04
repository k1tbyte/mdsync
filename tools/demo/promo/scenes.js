// The plan. A scene shows one take (artifacts/demos/<take>.mp4, `size` its pixels) through `clips`, [from, to, speed = 1]
// in take seconds, played back to back; a gap between two clips dissolves. A camera key is [take second, left, top, width]
// in take pixels, eased between keys. Neighbour scenes overlap for the cross-fade; one take in a row stays in place.

// biome-ignore lint/correctness/noUnusedVariables: index.html reads it as a global.
const SCENES = [
	{ cover: "intro", length: 3.6 },
	{
		kicker: "Set up",
		headline: "Your storage, your keys. <b>Set up in a minute.</b>",
		take: "wizard",
		size: [1920, 1400],
		clips: [
			[0.6, 4.6],
			[4.8, 9.9, 1.4],
			[11.4, 17.7, 1.4],
		],
		zoom: [[0, 130, 80, 1660]],
	},
	{
		kicker: "Relay",
		headline: "Your own relay, deployed for you. <b>Free tier.</b>",
		take: "wizard",
		size: [1920, 1400],
		clips: [
			[18.0, 22.9],
			[23.3, 31.9, 1.8],
		],
		zoom: [[18, 130, 80, 1660]],
	},
	{
		kicker: "First sync",
		headline: "Encrypted on your device. <b>You approve the first sync.</b>",
		take: "wizard",
		size: [1920, 1400],
		clips: [[32.4, 41.6]],
		zoom: [[32, 130, 80, 1660]],
	},
	{
		kicker: "Changes",
		headline: "See every change. <b>Push when you're ready.</b>",
		take: "changes",
		size: [1920, 1200],
		clips: [
			[1.4, 10.4],
			[23.0, 29.6],
		],
		zoom: [
			[6.4, 0, 0, 1920],
			[7.4, 0, 0, 1470],
			[9.6, 0, 0, 1470],
			[10.4, 0, 0, 1920],
		],
	},
	{
		kicker: "Conflicts",
		headline: "Edited on two devices? <b>Merge line by line.</b>",
		take: "merge",
		size: [1920, 1200],
		aspect: [1920, 900],
		clips: [
			[0.8, 10.4],
			[11.4, 14.6],
		],
	},
	{
		kicker: "History",
		headline: "Every push is kept. <b>Roll back a file or the vault.</b>",
		take: "timeline",
		size: [1920, 1200],
		clips: [
			[1.4, 4.0],
			[5.6, 12.6, 1.2],
			[16.6, 22.4, 1.2],
			[26.2, 28.8],
		],
	},
	{
		kicker: "Live editing",
		headline: "Type together, <b>keystroke by keystroke.</b>",
		take: "live",
		size: [1920, 850],
		aspect: [1920, 560],
		clips: [
			[1.4, 10.4],
			[14.8, 18.0],
		],
	},
	{
		kicker: "Shared folders",
		headline: "Invite people to a folder. <b>Your keys stay yours.</b>",
		take: "share",
		size: [1920, 850],
		clips: [
			[1.2, 9.6, 1.2],
			[15.6, 22.6, 1.3],
			[26.0, 30.0],
		],
	},
	{
		kicker: "Share links",
		headline: "Send a note as a link. <b>Expiry, views, passphrase.</b>",
		take: "links",
		size: [1920, 1200],
		clips: [[0.6, 11.0, 1.15]],
		zoom: [[0, 190, 110, 1540]],
	},
	{
		kicker: "Share links",
		headline: "Opens in any browser. <b>Revoke it any time.</b>",
		take: "links",
		size: [1920, 1200],
		clips: [
			[14.8, 18.0],
			[18.8, 23.0],
			[30.4, 36.0, 1.2],
			[38.2, 41.4],
		],
		// The viewer's passphrase form and its "no longer available" page are small in an empty page.
		zoom: [
			[14.8, 460, 100, 1000],
			[18.8, 460, 100, 1000],
			[20.0, 0, 0, 1920],
			[38.2, 0, 0, 1920],
			[39.4, 460, 60, 1000],
		],
	},
	{
		kicker: "Status bar",
		headline: "Every relay and the folders on it. <b>One look.</b>",
		take: "status",
		size: [1920, 1372],
		clips: [[1.2, 9.0]],
		zoom: [[0, 520, 372, 1400]],
	},
	{ cover: "outro", length: 4.5 },
];
