// Staging-only behavior. The build replaces all production contact integrations.
document.querySelectorAll('a[href^="mailto:"]').forEach((link) => {
  link.removeAttribute("href");
  link.setAttribute("aria-disabled", "true");
});
