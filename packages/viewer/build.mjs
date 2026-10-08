import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = (path) => fileURLToPath(new URL(path, import.meta.url));
// The relay serves this folder under /viewer/ (wrangler.toml `assets`).
const out = root("./dist/viewer");

rmSync(root("./dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await esbuild.build({
	entryPoints: [root("./src/main.ts"), root("./src/viewer.css")],
	entryNames: "viewer",
	outdir: out,
	bundle: true,
	minify: true,
	format: "iife",
	target: ["es2022", "chrome111", "safari16.4"],
	tsconfig: root("./tsconfig.json"),
	logLevel: "info",
});
copyFileSync(root("./src/index.html"), `${out}/index.html`);
