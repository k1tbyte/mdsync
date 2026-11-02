# Demo recordings

Each script drives real Obsidian windows over CDP and writes `artifacts/demos/<name>.webp`.

```bash
pnpm exec jiti tools/demo/readonly.ts
DEMO_HOLD=1 pnpm exec jiti tools/demo/readonly.ts   # stage the scene and keep Obsidian open
```

- Needs Obsidian, `ffmpeg` and, for `drawing.ts`, network access once (fetches the Excalidraw plugin).
- `img2webp` (libwebp tools) when the `ffmpeg` build has no libwebp, as Homebrew's: it packs the frames instead.
- The pointer is drawn from `pointer.cur`, `link.cur` and `beam.cur` in `artifacts/cursors/` (not in git), a plain arrow without them.
- Solo demos: `changes marks merge history timeline deleted`. Pair demos (two panes, relay and S3 on localhost): `share readonly live presence follow drawing`.
- `links.ts` films Obsidian and a headless browser one after another (relay on localhost, no S3): a link created, read, then stopped.
- `transfer.ts` films two windows one after another (no relay): the setup QR, `scan.ts` overlay, then the import prompt.
- `stage.ts` and `pair.ts` build the vaults, `recorder.ts` films and encodes, `cursor.ts` draws the pointer.
- Copy the results to `docs/demos/` for the README.
- `hero.html` is the README banner. Take its frames from the demos with `uv run --with pillow python tools/demo/frames.py save merge 112` (also `changes 28`, `live 126`), render it with headless Chrome (`--window-size=1280,640 --force-device-scale-factor=2 --screenshot=hero.png`) and encode to `docs/hero.webp` with ffmpeg (`-c:v libwebp -quality 90`) or `cwebp -q 90`.
- `listing.py` renders the five listing screenshots (1200x800, `listing.html` is the template) from the frames of `docs/demos` into `artifacts/listing/`: `uv run --with pillow python tools/demo/listing.py` (`CHROME` overrides the browser path). Frame picks and captions are its `SHOTS` list. Upload them under Edit listing at community.obsidian.md.
