import { animate, stagger } from 'animejs';
import { gsap } from 'gsap';
import './visual.css';

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const arcAnimations = new WeakMap();

document.addEventListener('pianyu:progress', ({ detail: { arc, percent } }) => {
  arcAnimations.get(arc)?.cancel();
  if (percent === null || percent === 0 || reduced.matches) {
    arc.style.strokeDashoffset = String(100 - (percent ?? 0));
    return;
  }
  arcAnimations.set(arc, animate(arc, { strokeDashoffset: 100 - percent, duration: 240, ease: 'outQuad' }));
});

document.addEventListener('pianyu:reveal', ({ target }) => {
  if (reduced.matches || target.id !== 'recent-projects' || !target.childElementCount) return;
  animate([...target.children], { x: [-7, 0], opacity: [.55, 1], duration: 260, delay: stagger(36), ease: 'outQuad' });
});

let listShown = false;
function revealRecentOnOpen() {
  if (listShown || document.body.dataset.page !== 'video') return;
  listShown = true;
  document.getElementById('recent-projects').dispatchEvent(new Event('pianyu:reveal', { bubbles: true }));
}
addEventListener('hashchange', revealRecentOnOpen);
revealRecentOnOpen();

for (const card of document.querySelectorAll('.glass-card')) {
  card.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || reduced.matches) return;
    const bounds = card.getBoundingClientRect();
    card.style.setProperty('--spot-x', `${event.clientX - bounds.left}px`);
    card.style.setProperty('--spot-y', `${event.clientY - bounds.top}px`);
  });
}

const editor = document.getElementById('editor');
new MutationObserver(() => {
  if (editor.hidden || reduced.matches) return;
  gsap.from(editor.querySelectorAll('.editor-head, .editing > .panel, .prompts'), {
    y: 7, opacity: .6, duration: .29, stagger: .04, ease: 'power2.out', clearProps: 'transform,opacity'
  });
}).observe(editor, { attributes: true, attributeFilter: ['hidden'] });
