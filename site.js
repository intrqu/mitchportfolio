const menu = document.querySelector('.menu');
const nav = document.querySelector('#nav');
const mobile = window.matchMedia('(max-width: 700px)');

function setMenu(open) {
  menu.hidden = !mobile.matches;
  menu.setAttribute('aria-expanded', String(mobile.matches && open));
  nav.hidden = mobile.matches && !open;
}

setMenu(false);
mobile.addEventListener('change', () => setMenu(false));
menu.addEventListener('click', () => setMenu(nav.hidden));
nav.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (link && mobile.matches) {
    setMenu(false);
    const destination = document.querySelector(link.hash);
    destination.setAttribute('tabindex', '-1');
    destination.focus({ preventScroll: true });
  }
});
document.querySelector('header').addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    setMenu(false);
    menu.focus();
  }
});

const lightbox = document.querySelector('#lightbox');
const artImage = document.querySelector('#art-image');
const artTitle = document.querySelector('#art-title');
let activeArtwork;

for (const link of document.querySelectorAll('.gallery .art-link')) {
  link.setAttribute('aria-haspopup', 'dialog');
  link.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const image = link.querySelector('img');
    activeArtwork = link;
    artImage.src = image.src;
    artImage.alt = image.alt;
    artTitle.textContent = link.nextElementSibling.querySelector('span').textContent;
    lightbox.showModal();
  });
}
lightbox.addEventListener('close', () => activeArtwork?.focus());

const inquiry = document.querySelector('#inquiry');
const status = document.querySelector('#status');
inquiry.hidden = false;
inquiry.addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = new FormData(inquiry);
  const body = [
    'Mitch Harsch Tattoo Inquiry',
    'Name: ' + fields.get('name').trim(),
    'Email: ' + fields.get('email').trim(),
    '',
    'Tattoo idea',
    fields.get('idea').trim()
  ].join('\n');
  const params = new URLSearchParams({
    subject: 'Tattoo inquiry from ' + fields.get('name').trim(),
    body
  });
  window.location.href = 'mailto:mitchharsch@gmail.com?' + params.toString();
  status.textContent = 'Your email app should open with the inquiry ready to review and send.';
});

