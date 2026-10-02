# Releasing

## Manifest (`manifest.json`)

- Must include (non-exhaustive): `id` (matches the plugin folder name for local dev), `name`, `version` (SemVer `x.y.z`), `minAppVersion`, `description`, `isDesktopOnly` (boolean). Optional: `author`, `authorUrl`, `fundingUrl` (string or map).
- Never change `id` after release; treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Process

- Add a `## [x.y.z] - YYYY-MM-DD` section at the top of `CHANGELOG.md`: plain sentences for users under `### Important`, `### Features`, `### Improvements` or `### Fixes`, never commit titles. It is the source of truth for release notes.
- Bump `version` (`pnpm version x.y.z`): `version-bump.mjs` refuses a version without a changelog section, then updates `manifest.json` and `versions.json` (plugin version → minimum app version).
- Push a tag equal to `manifest.json`'s `version` - no leading `v`. The Release workflow checks that tag, manifest and the newest changelog section agree, builds, attests the assets, and creates the GitHub release with that section as its notes. CI runs the same check (`node tools/changelog.mjs check`) on every push.
- The release carries `manifest.json`, `main.js`, and `styles.css` as individual assets. `main.js` and `styles.css` are both build outputs of `pnpm build`. Release artifacts live at the top level of the plugin folder in the vault (`<Vault>/.obsidian/plugins/<plugin-id>/`).
- Plugins are submitted at community.obsidian.md (sign in, connect GitHub, Plugins → New plugin); its scan checks the manifest, the release assets, the source and that the build matches it. Fix findings with a new, higher version.

## References

- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide
