---
paths:
  - 'manifest.json'
  - 'versions.json'
  - 'version-bump.mjs'
  - 'CHANGELOG.md'
  - '.github/workflows/**'
  - 'packages/plugin/package.json'
  - 'packages/plugin/esbuild*.mjs'
---

# Releasing

## Manifest (`manifest.json`)

- Required: `id`, `name`, `version` (SemVer `x.y.z`), `minAppVersion`, `description`, `isDesktopOnly` (boolean, false here: the plugin runs on mobile). Optional: `author`, `authorUrl`, `fundingUrl`. Canonical checks: obsidianmd/obsidian-releases `validate-plugin-entry.yml`.
- Never change `id` (`mdsync`) after release: it is the plugin folder name and stable API.
- Keep `minAppVersion` accurate when using newer Obsidian APIs; `versions.json` maps each plugin version to its minimum app version.

## Process

- Add a `## [x.y.z] - YYYY-MM-DD` section at the top of `CHANGELOG.md`: plain sentences for users under `### Important`, `### Features`, `### Improvements` or `### Fixes`, never commit titles. It is the source of truth for release notes.
- Bump with `pnpm version x.y.z`: `version-bump.mjs` refuses a version without a changelog section, then updates `manifest.json`, `packages/plugin/package.json` and `versions.json`.
- Push a tag equal to `manifest.json`'s `version`, no leading `v`. `.github/workflows/release.yml` checks that tag, manifest and newest changelog section agree (`node tools/changelog.mjs check`), builds with `pnpm --filter mdsync run build`, attests the assets and creates the GitHub release with that section as notes. `lint.yml` (CI) runs the same check on every push, then build, lint, typecheck and tests.
- The release carries `manifest.json`, `packages/plugin/main.js` and `packages/plugin/styles.css` as individual assets; the last two are build outputs of the build, never committed.
- The relay ships inside the plugin: `packages/plugin/esbuild.relay-bundle.mjs` bundles `packages/relay` as `mdsync:relay-bundle`, version `<plugin version>+<hash>`. It is built in the same run, so a release deploys the relay of its own commit, and relay versions order releases (an older plugin never offers a downgrade).
- `.github/workflows/deploy-relay.yml` is a manual deploy of the relay to a Cloudflare account from repository secrets (`CLOUDFLARE_*`, `RELAY_SECRET`, optional `GDRIVE_*`); it does not touch the plugin release.
- Plugins are submitted at community.obsidian.md (sign in, connect GitHub, Plugins, New plugin); its scan checks the manifest, the release assets, the source and that the build matches it. Fix findings with a new, higher version.

## References

- https://docs.obsidian.md, Developer policies, Plugin guidelines (`docs.obsidian.md/Plugins/Releasing/Plugin+guidelines`), Style guide (`help.obsidian.md/style-guide`).
