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
- `wizard.ts` films the setup wizard from the storage choice to the first sync, with `fake-cloudflare.ts` standing in for the Cloudflare API, the new worker and R2 (forwarded to a local S3), so no account is needed. `status.ts` films the status bar menu with two relays staged.
- A pane's `scale` (device pixel ratio) overrides the recorder's default; a small window needs a high one to stay sharp at `DEMO_WIDTH`.
- `transfer.ts` films two windows one after another (no relay): the setup QR, `scan.ts` overlay, then the import prompt.
- `stage.ts` and `pair.ts` build the vaults, `recorder.ts` films and encodes, `cursor.ts` draws the pointer.
- Copy the results to `docs/demos/` for the README.
- `DEMO_VIDEO=1 DEMO_WIDTH=1920 DEMO_SPEED=1` records `artifacts/demos/<name>.mp4` at full size and real speed, for cutting into a video, instead of the README's WebP (`DEMO_WIDTH` and `DEMO_SPEED` also apply to the WebP).
- `hero.html` is the README banner. Take its frames from the demos with `uv run --with pillow python tools/demo/frames.py save merge 112` (also `changes 28`, `live 126`), render it with headless Chrome (`--window-size=1280,640 --force-device-scale-factor=2 --screenshot=hero.png`) and encode to `docs/hero.webp` with ffmpeg (`-c:v libwebp -quality 90`) or `cwebp -q 90`.
- `listing.py` renders the five listing screenshots (1200x800, `listing.html` is the template) from the frames of `docs/demos` into `artifacts/listing/`: `uv run --with pillow python tools/demo/listing.py` (`CHROME` overrides the browser path). Frame picks and captions are its `SHOTS` list. Upload them under Edit listing at community.obsidian.md.

## Promo video

`promo/` cuts the full-size takes into a captioned 1920x1080 video (30 fps, muted: the captions carry it), in the look of the README cover (`docs/hero/`).

```bash
tools/demo/take.sh wizard changes merge timeline live share links status   # artifacts/demos/<name>.mp4
node tools/demo/promo/render.mjs artifacts/promo.mp4                        # needs ffmpeg; CHROME=<path> for another browser
node tools/demo/promo/render.mjs - 30 4,16,23.5                             # stills at those seconds, in artifacts/promo/stills
```

- `promo/scenes.js` is the plan: per scene a kicker and headline, the take it shows, the stretches of it played back to back (`clips`, `[from, to, speed]` in take seconds; a gap between two dissolves) and the camera (`zoom`, `[take second, x, y, w]` in the take's pixels). `aspect` crops a take whose lower part stays empty. Two scenes of one take in a row keep the window in place. Every take plays at `PACE` (`timeline.js`), and a still stretch inside a scene (ffmpeg `freezedetect`, found by `render.mjs`) is squeezed to `HOLD` seconds.
- `promo/index.html` is the look (cover palette and cards, Hanken Grotesk), `promo/timeline.js` poses it for `window.setTime(t)`, which `promo/render.mjs` screenshots frame by frame after extracting the take seconds the plan reads into `artifacts/promo/frames`.
- `take.sh` runs the takes in the video mode below and runs a failed one again: Obsidian's trust dialog now and then swallows the first click. On headless Linux start `Xvfb :99 -screen 0 2560x1440x24 -nolisten tcp` first; `obsidian-xvfb.sh` is the `OBSIDIAN_EXE` it uses (`OBSIDIAN_BIN` for another install path).
- `promo/fonts/` holds Hanken Grotesk, variable 400-800 (SIL OFL 1.1).
