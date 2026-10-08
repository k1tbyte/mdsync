/** CSS cannot tell a paragraph holding only an image from one that also has text. */
export function markLoneImages(body: HTMLElement): void {
	for (const p of Array.from(body.querySelectorAll("p"))) {
		if (p.querySelector("img") && p.textContent?.trim() === "") {
			p.classList.add("lone-image");
		}
	}
}
