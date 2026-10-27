const DOMAIN = "(storage|sync|live|presence|spaces|links|relay|transfer)";
const SURFACES = {
	diff: [],
	"editor-signs": [],
	explorer: [],
	"note-header": [],
	settings: [],
	setup: ["settings"],
	"source-control": ["diff", "setup"],
	status: ["diff", "source-control"],
};
const SLICE = "^src/(features|core)/[^/]+/";
const FACADE = "^src/(features|core)/[^/]+/index\\.ts$";

const surfaceRules = Object.entries(SURFACES).map(([from, allowed]) => ({
	name: `surface-${from}`,
	comment: `${from} may reach other surfaces only: ${allowed.join(", ") || "none"}`,
	severity: "error",
	from: { path: `^src/features/${from}/` },
	to: {
		path: `^src/features/(${Object.keys(SURFACES).join("|")})/`,
		pathNot: [
			`^src/features/${from}/`,
			...allowed.map((s) => `^src/features/${s}/`),
		],
	},
}));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "no-circular",
			severity: "error",
			from: {},
			to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
		},
		{
			name: "slice-via-facade",
			comment: "Another slice is reached through its index.ts only",
			severity: "error",
			from: { path: "^src/(features|core)/([^/]+)/" },
			to: { path: SLICE, pathNot: ["^src/$1/$2/", FACADE] },
		},
		{
			name: "root-via-facade",
			comment: "app/ and main.ts reach slices through their index.ts only",
			severity: "error",
			from: { path: "^src/", pathNot: SLICE },
			to: { path: SLICE, pathNot: FACADE },
		},
		{
			name: "core-independent",
			comment: "core/ knows no feature and no app",
			severity: "error",
			from: { path: "^src/core/" },
			to: { path: "^src/(features|app)/" },
		},
		{
			name: "features-not-app",
			comment:
				"A feature declares its deps instead of importing the composition root",
			severity: "error",
			from: { path: "^src/features/" },
			to: { path: "^src/(app/|main\\.ts$)" },
		},
		{
			name: "domain-not-surface",
			severity: "error",
			from: { path: `^src/features/${DOMAIN}/` },
			to: { path: `^src/features/(${Object.keys(SURFACES).join("|")})/` },
		},
		...surfaceRules,
	],
	options: {
		doNotFollow: { path: "node_modules" },
		exclude: { path: "\\.d\\.ts$" },
		tsPreCompilationDeps: true,
		tsConfig: { fileName: "tsconfig.json" },
		enhancedResolveOptions: { extensions: [".ts", ".js"] },
	},
};
