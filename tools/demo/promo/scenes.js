// Scene plan. Scene i starts at B[i] and holds until B[i+1] + 0.6, so neighbours cross-fade.
// A seg is [out0, out1, src0, src1]: output seconds from the scene's start, seconds of the recorded take.
// A zoom point is [t, x, y, w]: scene seconds, and the crop's left, top and width in source pixels.
const B = [0, 6, 10, 14, 19, 25.5, 30.5, 35.5, 42, 49, 52.5, 55.5];
const span = (i) => ({
	start: B[i],
	end: i === B.length - 2 ? B[i + 1] : B[i + 1] + 0.6,
});
const segs = (i, list) =>
	list.map(([a, b, s0, s1]) => [B[i] + a, B[i] + b, s0, s1]);
const zoom = (i, list) => list.map(([t, x, y, w]) => [B[i] + t, x, y, w]);

// biome-ignore lint/correctness/noUnusedVariables: index.html reads it as a global.
const SCENES = [
	{
		...span(0),
		kicker: "Set up",
		headline: "Your storage, your relay. <b>A few clicks, free tier.</b>",
		layers: [
			{
				name: "wizard",
				size: [1920, 1400],
				segs: segs(0, [
					[0, 1.3, 3.0, 4.8],
					[1.3, 2.5, 5.5, 10.9],
					[2.5, 3.3, 24.5, 26.5],
					[3.3, 5.5, 27.0, 32.5],
					[5.5, 6.6, 32.5, 36.8],
				]),
				zoom: zoom(0, [
					[0, 270, 175, 1380],
					[2.2, 270, 175, 1380],
					[2.8, 160, 100, 1560],
					[3.3, 160, 100, 1560],
					[3.9, 270, 175, 1380],
				]),
			},
		],
	},
	{
		...span(1),
		kicker: "First sync",
		headline: "Encrypted on your device. <b>You approve the first sync.</b>",
		layers: [
			{
				name: "wizard",
				size: [1920, 1400],
				segs: segs(1, [
					[0, 2, 37.3, 40.4],
					[2, 4.6, 40.4, 43.9],
				]),
				zoom: zoom(1, [[0, 310, 100, 1300]]),
			},
		],
	},
	{
		...span(2),
		kicker: "Changes",
		headline: "See every change. <b>Push when you're ready.</b>",
		layers: [
			{
				name: "changes",
				size: [1920, 1200],
				aspect: [1600, 850],
				segs: segs(2, [
					[0, 2, 0.2, 5.0],
					[2, 4.6, 23.0, 28.6],
				]),
				zoom: zoom(2, [
					[0, 0, 0, 1920],
					[1.8, 0, 0, 1920],
					[2.5, 0, 120, 1920],
				]),
			},
		],
	},
	{
		...span(3),
		kicker: "Conflicts",
		headline: "Edited on two devices? <b>Merge line by line.</b>",
		layers: [
			{
				name: "merge",
				size: [1920, 1200],
				aspect: [1600, 850],
				segs: segs(3, [
					[0, 1.2, 1.2, 3.6],
					[1.2, 2.4, 3.6, 6.0],
					[2.4, 4.4, 8.0, 13.0],
					[4.4, 5.6, 14.6, 17.4],
				]),
				zoom: zoom(3, [
					[0, 0, 60, 1920],
					[1.4, 0, 60, 1920],
					[2.2, 0, 110, 1600],
					[4.0, 0, 110, 1600],
					[4.7, 0, 60, 1920],
				]),
			},
		],
	},
	{
		...span(4),
		kicker: "History",
		headline: "Every push is kept. <b>Roll back a file or the vault.</b>",
		layers: [
			{
				name: "timeline",
				size: [1920, 1200],
				aspect: [1600, 850],
				// The vault restore sits at the very bottom of the panel: the camera drops there for the click, then onto the dialog.
				segs: segs(4, [
					[0, 1.2, 1.5, 4.2],
					[1.2, 2.2, 10.6, 12.4],
					[2.2, 3.8, 18.8, 20.8],
					[3.8, 6.2, 20.8, 25.6],
					[6.2, 7.1, 26.0, 27.7],
				]),
				zoom: zoom(4, [
					[0, 0, 0, 1920],
					[2.0, 0, 0, 1920],
					[2.6, 820, 560, 1100],
					[3.6, 820, 560, 1100],
					[4.3, 300, 180, 1320],
					[6.0, 300, 180, 1320],
					[6.7, 0, 0, 1920],
				]),
			},
		],
	},
	{
		...span(5),
		kicker: "Live editing",
		headline: "Type together, <b>keystroke by keystroke.</b>",
		layers: [
			{
				name: "live",
				size: [1920, 850],
				aspect: [1600, 640],
				segs: segs(5, [
					[0, 2.8, 2.0, 7.6],
					[2.8, 4.0, 11.0, 14.0],
					[4.0, 5.6, 16.2, 19.0],
				]),
				zoom: zoom(5, [[0, 60, 110, 1600]]),
			},
		],
	},
	{
		...span(6),
		kicker: "Shared folders",
		headline: "Invite people to a folder. <b>Your keys stay yours.</b>",
		layers: [
			{
				name: "share",
				size: [1920, 850],
				aspect: [1600, 850],
				segs: segs(6, [
					[0, 1.2, 1.2, 2.8],
					[1.2, 2.7, 6.4, 10.0],
					[2.7, 4.0, 23.0, 25.8],
					[4.0, 5.6, 31.2, 34.0],
				]),
				zoom: zoom(6, [
					[0, 0, 30, 1300],
					[2.4, 0, 30, 1300],
					[3.0, 620, 30, 1300],
				]),
			},
		],
	},
	{
		...span(7),
		kicker: "Share links",
		headline: "Send a note as a link. <b>Expiry, views, passphrase.</b>",
		layers: [
			{
				name: "links",
				size: [1920, 1200],
				segs: segs(7, [
					[0, 1.6, 1.5, 3.5],
					[1.6, 4.9, 3.6, 10.6],
					[4.9, 7.1, 10.6, 14.4],
				]),
				zoom: zoom(7, [
					[0, 0, 330, 1200],
					[1.6, 0, 330, 1200],
					[2.1, 430, 100, 1100],
					[4.5, 430, 100, 1100],
					[5.2, 430, 320, 1100],
				]),
			},
		],
	},
	{
		...span(8),
		kicker: "Share links",
		headline: "Opens in any browser. <b>Revoke it any time.</b>",
		layers: [
			{
				name: "links",
				size: [1920, 1200],
				segs: segs(8, [
					[0, 1.6, 20.2, 23.4],
					[1.6, 3.9, 23.5, 27.5],
					[3.9, 5.3, 36.4, 40.2],
					[5.3, 6.3, 41.0, 43.4],
					[6.3, 7.6, 46.0, 47.5],
				]),
				zoom: zoom(8, [
					[0, 500, 160, 920],
					[1.4, 500, 160, 920],
					[1.9, 200, 40, 1600],
					[3.6, 200, 40, 1600],
					[4.0, 300, 180, 1300],
					[5.0, 300, 180, 1300],
					[5.3, 380, 260, 1100],
					[6.0, 380, 260, 1100],
					[6.3, 500, 100, 920],
				]),
			},
		],
	},
	{
		...span(9),
		kicker: "Status bar",
		headline: "Every relay and the folders on it. <b>One look.</b>",
		layers: [
			{
				name: "status",
				size: [1920, 1372],
				segs: segs(9, [
					[0, 2.1, 1.8, 5.8],
					[2.1, 4.1, 5.8, 8.6],
				]),
				zoom: zoom(9, [[0, 420, 300, 1500]]),
			},
		],
	},
	{
		...span(10),
		kicker: "Free community plugin",
		headline: "Search <b>MDSync</b> in Obsidian.",
		noBrand: true,
		lockup: {
			what: "Encrypted vault sync for Obsidian",
			url: "community.obsidian.md/plugins/mdsync",
		},
	},
];
