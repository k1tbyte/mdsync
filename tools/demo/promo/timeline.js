// Poses the stage for any output second: render.mjs calls window.setTime(t) per frame and reads window.RANGES first.
const FPS_SRC = 30;
// render.mjs extracts the take frames there, out of git.
const FRAMES = "../../../artifacts/promo/frames";
const AREA = { x: 96, y: 236, w: 1728, h: 800 };
const PAD = 12;
const OVERLAP = 0.9;
// A jump between two stretches of one take dissolves instead of cutting.
const DISSOLVE = 0.5;
// Takes are filmed at a human pace; the promo plays them faster.
const PACE = 1.3;
// A still stretch inside a scene lasts at most this long: nothing moves, so the speed-up is unseen.
const HOLD = 0.7;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const ramp = (t, from, length) => ease(clamp((t - from) / length));

/** Eased value between the keyframes `[t, ...values]` around `t`. */
function pick(points, t) {
	if (t <= points[0][0]) return points[0].slice(1);
	for (let i = 1; i < points.length; i++) {
		if (t > points[i][0]) continue;
		const [t0, ...a] = points[i - 1];
		const [t1, ...b] = points[i];
		// Keys at either side of a skipped gap can land on one output second.
		const k = t1 > t0 ? ease((t - t0) / (t1 - t0)) : 1;
		return a.map((v, j) => v + (b[j] - v) * k);
	}
	return points.at(-1).slice(1);
}

/** The take second shown at scene second `t`, and the one dissolving away after a jump. */
function sourceAt(segs, t) {
	if (t <= segs[0][0]) return { src: segs[0][2] };
	for (const [i, [o0, o1, s0, s1]] of segs.entries()) {
		if (t > o1 && i < segs.length - 1) continue;
		const src = s0 + (s1 - s0) * clamp((t - o0) / (o1 - o0));
		const prev = segs[i - 1];
		const jumped = prev && Math.abs(prev[3] - s0) > 2 / FPS_SRC;
		if (!jumped || t > o0 + DISSOLVE) return { src };
		return { src, under: prev[3], mix: ramp(t, o0, DISSOLVE) };
	}
}

const stage = document.getElementById("stage");
const cover = document.getElementById("cover");
const brand = document.getElementById("brand");
const blobs = [
	document.getElementById("blob-a"),
	document.getElementById("blob-b"),
];
const coverParts = [...cover.querySelectorAll("[data-in]")];

/** Output second of take second `src`: the first clip reaching it, or the start of the next one after a skipped gap. */
function outAt(segs, src) {
	for (const [o0, o1, s0, s1] of segs) {
		if (src <= s1)
			return src <= s0 ? o0 : o0 + ((src - s0) / (s1 - s0)) * (o1 - o0);
	}
	return segs.at(-1)[1];
}

/** Clips as [out from, out to, take from, take to], `holds` (render.mjs finds them) squeezed to HOLD. */
function plan(clips, holds) {
	const segs = [];
	let out = 0;
	const add = (s0, s1, length) => {
		if (s1 <= s0) return;
		segs.push([out, out + length, s0, s1]);
		out += length;
	};
	// The first and last moments of a scene stay whole: they sit under the cross-fade.
	const [first, last] = [clips[0][0], clips.at(-1)[1]];
	for (const [s0, s1, speed = 1] of clips) {
		let from = s0;
		for (const [h0, h1] of holds) {
			const a = Math.max(h0, from);
			const b = Math.min(h1, s1);
			if (b <= a || a <= first || b >= last) continue;
			add(from, a, (a - from) / (speed * PACE));
			add(a, b, Math.min(HOLD, (b - a) / (speed * PACE)));
			from = b;
		}
		add(from, s1, (s1 - from) / (speed * PACE));
	}
	return segs;
}

let at = 0;
for (const scene of SCENES) {
	if (scene.clips) {
		scene.segs = plan(scene.clips, window.HOLDS?.[scene.take] ?? []);
		scene.length = scene.segs.at(-1)[1];
		scene.zoom = (scene.zoom ?? [[0, 0, 0, scene.size[0]]]).map(
			([src, ...pose]) => [outAt(scene.segs, src), ...pose],
		);
	}
	scene.start = at;
	scene.end = at + scene.length;
	at = scene.end - OVERLAP;
	if (scene.cover) continue;

	scene.caption = document.createElement("div");
	scene.caption.className = "caption";
	scene.caption.innerHTML =
		'<div class="chip"></div><div class="headline"></div>';
	scene.caption.firstChild.textContent = scene.kicker.toUpperCase();
	scene.caption.lastChild.innerHTML = scene.headline;

	// `aspect` crops a take whose lower part stays empty; the camera keeps it, so nothing else is cut.
	const [sw, sh] = scene.size;
	const [aw, ah] = scene.aspect ?? scene.size;
	const width = Math.min(AREA.w - 2 * PAD, (AREA.h - 2 * PAD) * (aw / ah));
	scene.box = { width, height: width / (aw / ah) };
	scene.win = document.createElement("div");
	scene.win.className = "win";
	scene.win.style.cssText = `left:${AREA.x + (AREA.w - width - 2 * PAD) / 2}px;top:${AREA.y + (AREA.h - scene.box.height - 2 * PAD) / 2}px`;
	scene.win.innerHTML = `<div class="clip" style="width:${width}px;height:${scene.box.height}px"><img alt=""><img alt=""></div>`;
	scene.imgs = [...scene.win.querySelectorAll("img")].map((img) => {
		img.style.width = `${sw}px`;
		img.style.height = `${sh}px`;
		return { img, shown: -1 };
	});
	stage.append(scene.caption, scene.win);
}

/** Every take's source seconds the plan reads, merged, for render.mjs to extract. */
window.RANGES = {};
for (const { take, segs } of SCENES.filter((s) => s.take)) {
	const list = [
		...(window.RANGES[take] ?? []),
		...segs.map(([, , s0, s1]) => [s0, s1 + 0.2]),
	].sort((a, b) => a[0] - b[0]);
	window.RANGES[take] = list.reduce((merged, [a, b]) => {
		const last = merged.at(-1);
		if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
		else merged.push([a, b]);
		return merged;
	}, []);
}

/** Loads a take frame; a range's last frame can be missing, so it falls back a few frames. */
async function show(layer, take, index) {
	if (layer.shown === index) return;
	layer.shown = index;
	for (let back = 0; back < 4; back++) {
		layer.img.src = `${FRAMES}/${take}/${String(index - back).padStart(4, "0")}.jpg`;
		try {
			return await layer.img.decode();
		} catch {}
	}
}

function poseTake(scene, local, decoded) {
	const { src, under, mix = 1 } = sourceAt(scene.segs, local);
	// The later <img> paints on top: the incoming frame fades in over the one it replaces.
	const [bottom, top] = scene.imgs;
	decoded.push(show(top, scene.take, Math.round(src * FPS_SRC)));
	top.img.style.opacity = mix;
	bottom.img.style.display = under === undefined ? "none" : "";
	if (under !== undefined)
		decoded.push(show(bottom, scene.take, Math.round(under * FPS_SRC)));

	const [sw, sh] = scene.size;
	const [x, y, w] = pick(scene.zoom, local);
	const zw = Math.min(w, sw);
	const scale = scene.box.width / zw;
	const zx = clamp(x, 0, sw - zw);
	const zy = clamp(y, 0, sh - scene.box.height / scale);
	for (const { img } of scene.imgs) {
		img.style.transform = `translate(${-zx * scale}px, ${-zy * scale}px) scale(${scale})`;
	}
}

function poseCover(scene, local, alpha) {
	for (const id of ["intro", "outro"]) {
		document.getElementById(`${id}-text`).style.display =
			scene.cover === id ? "" : "none";
	}
	cover.style.opacity = alpha;
	for (const part of coverParts) {
		const k = ramp(local, Number(part.dataset.in), 0.6);
		part.style.opacity = k;
		part.style.translate = `0 ${(1 - k) * 36}px`;
	}
}

window.setTime = async (t) => {
	const decoded = [];
	let coverOn = 0;
	cover.style.display = "none";
	for (const [i, scene] of SCENES.entries()) {
		const live = t >= scene.start - 0.001 && t <= scene.end + 0.001;
		if (scene.win) {
			scene.win.style.display = scene.caption.style.display = live
				? ""
				: "none";
		}
		if (!live) continue;

		// The next scene of the same take fades in on top of this one, which holds still under it.
		// A cover and a take hand over through the bare background: one is gone before the other comes.
		const prev = SCENES[i - 1];
		const next = SCENES[i + 1];
		const joinedIn = scene.take && prev?.take === scene.take;
		const local = t - scene.start;
		const into = !prev
			? 1
			: prev.cover || scene.cover
				? ramp(local, OVERLAP * 0.4, OVERLAP * 0.6)
				: ramp(local, 0, OVERLAP);
		const end = scene.length - OVERLAP;
		const away =
			!next || next.take === scene.take
				? 0
				: next.cover || scene.cover
					? ramp(local, end, OVERLAP * 0.5)
					: ramp(local, end, OVERLAP);
		const alpha = into * (1 - away);
		const move = joinedIn ? 1 : into;
		if (scene.cover) {
			cover.style.display = "";
			coverOn = Math.max(coverOn, alpha);
			poseCover(scene, local, alpha);
			continue;
		}

		scene.win.style.opacity = alpha;
		scene.win.style.transform = `translateY(${(1 - move) * 40 - away * 24}px) scale(${0.965 + 0.035 * move + 0.015 * away})`;
		const cin = ramp(local, OVERLAP * 0.4, 0.7);
		const cout = ramp(local, scene.length - OVERLAP, OVERLAP * 0.6);
		scene.caption.style.opacity = cin * (1 - cout);
		scene.caption.style.translate = `0 ${(1 - cin) * 24 - cout * 12}px`;
		poseTake(scene, local, decoded);
	}
	brand.style.opacity = 1 - coverOn;
	blobs[0].style.translate = `${Math.sin(t * 0.15) * 40}px ${Math.cos(t * 0.11) * 30}px`;
	blobs[1].style.translate = `${Math.cos(t * 0.13) * 36}px ${Math.sin(t * 0.09) * 26}px`;
	await Promise.all(decoded);
	await document.fonts.ready;
};

window.TOTAL = SCENES.at(-1).end;
window.setTime(0);
