declare module "*.toml?raw" {
	const text: string;
	export default text;
}

declare module "node:url" {
	export function fileURLToPath(url: string | URL): string;
}
