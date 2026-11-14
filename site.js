const menu = document.querySelector(".menu");
const nav = document.querySelector("#nav");
const mobile = window.matchMedia("(max-width: 700px)");

function setMenu(open) {
	menu.hidden = !mobile.matches;
	menu.setAttribute("aria-expanded", String(mobile.matches && open));
	nav.hidden = mobile.matches && !open;
}

setMenu(false);
mobile.addEventListener("change", () => setMenu(false));
menu.addEventListener("click", () => setMenu(nav.hidden));
nav.addEventListener("click", (event) => {
	const link = event.target.closest("a");
	if (link && mobile.matches) {
		setMenu(false);
		const samePage =
			link.pathname === location.pathname &&
			link.origin === location.origin;
		const destination =
			samePage && link.hash
				? document.getElementById(link.hash.slice(1))
				: null;
		if (!destination) return;
		destination.setAttribute("tabindex", "-1");
		destination.focus({ preventScroll: true });
	}
});
document.querySelector("header").addEventListener("keydown", (event) => {
	if (
		event.key === "Escape" &&
		menu.getAttribute("aria-expanded") === "true"
	) {
		setMenu(false);
		menu.focus();
	}
});

const lightbox = document.querySelector("#lightbox");
const artImage = document.querySelector("#art-image");
const artTitle = document.querySelector("#art-title");
let activeArtwork;

for (const link of document.querySelectorAll(".gallery .art-link")) {
	link.setAttribute("aria-haspopup", "dialog");
	link.addEventListener("click", (event) => {
		if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
			return;
		event.preventDefault();
		const image = link.querySelector("img");
		activeArtwork = link;
		artImage.src = image.src;
		artImage.alt = image.alt;
		artTitle.textContent =
			link.nextElementSibling.querySelector("span").textContent;
		lightbox.showModal();
	});
}
lightbox?.addEventListener("close", () => activeArtwork?.focus());

const inquiry = document.querySelector("#inquiry");
if (inquiry) inquiry.hidden = false;

(() => {
	const widget = document.querySelector("#instagram-grid");
	if (!widget) return;

	const selector = 'a[href*="elfsight.com/instagram-feed-instashow/"]';
	let activeRoot;
	let rootObserver;

	function hideAttribution() {
		const root = widget.querySelector(".es-embed-root")?.shadowRoot;
		if (!root) return;

		if (root !== activeRoot) {
			rootObserver?.disconnect();
			activeRoot = root;
			rootObserver = new MutationObserver(hideAttribution);
			rootObserver.observe(root, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["style", "href"],
			});
		}

		for (const link of root.querySelectorAll(selector)) {
			if (
				link.style.getPropertyValue("display") !== "none" ||
				link.style.getPropertyPriority("display") !== "important"
			) {
				link.style.setProperty("display", "none", "important");
			}
		}
	}

	const widgetObserver = new MutationObserver(hideAttribution);
	widgetObserver.observe(widget, { childList: true, subtree: true });

	// The shadow root can attach after the widget container appears.
	const startupCheck = setInterval(hideAttribution, 250);
	setTimeout(() => clearInterval(startupCheck), 15000);
	hideAttribution();
})();
