const hero = document.getElementById('welcome');
const typeCanvas = document.getElementById('home-type');
const glassCanvas = document.getElementById('home-glass');
const poster = hero.querySelector('.home-poster');
const title = document.getElementById('home-title');
const dots = [...hero.querySelectorAll('.home-dots button')];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const typeContext = typeCanvas.getContext('2d', { alpha: false });
const stencil = document.createElement('canvas');
const stencilContext = stencil.getContext('2d', { willReadFrequently: true });
const slides = [['让知识', '有画面'], ['把问题', '讲明白'], ['让灵感', '成一片']];
let index = 0;
let width = 0;
let height = 0;
let ratio = 1;
let visible = true;
let transition;
let glass;
let frame = 0;
let lastTime = 0;

function setTypeMetrics(context) {
  const compact = width < 740 || width < height;
  let size = Math.min(height * .235, width * (compact ? .252 : .178));
  const font = px => `800 ${px}px Poppins, "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
  context.font = font(size);
  const widest = Math.max(...slides[index].map(line => context.measureText(line).width));
  size *= Math.min(1, width * (compact ? .81 : .63) / widest);
  context.font = font(size);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  return size;
}

function drawHeadline(context, lines) {
  const size = setTypeMetrics(context);
  const gap = size * .96;
  const y = height * .465;
  context.fillStyle = '#efefef';
  context.fillText(lines[0], width * .5, y - gap / 2);
  context.fillText(lines[1], width * .5, y + gap / 2);
}

function sampleHeadline(lines) {
  stencil.width = width;
  stencil.height = height;
  drawHeadline(stencilContext, lines);
  const pixels = stencilContext.getImageData(0, 0, width, height).data;
  const step = Math.max(3, Math.round(Math.sqrt(width * height / 62000)));
  const dots = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (pixels[(y * width + x) * 4 + 3] < 128) continue;
      dots.push([x, y, Math.random() * .86 + .35, Math.random() * 2 - 1, Math.random()]);
    }
  }
  return dots;
}

const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => value * value * (3 - 2 * value);

function drawParticles(points, amount, direction, incoming) {
  typeContext.fillStyle = '#eee';
  for (const [x, y, size, offset, noise] of points) {
    const position = direction > 0 ? x / width : 1 - x / width;
    const delay = position * .34 + noise * .12;
    const progress = ease(clamp((amount - delay) / .54));
    const distance = incoming ? 1 - progress : progress;
    const dx = distance * direction * (incoming ? -1 : 1) * width * (.12 + noise * .35);
    const dy = distance * (offset * height * .29 + (incoming ? 28 : -28));
    typeContext.globalAlpha = incoming ? progress : (1 - progress) * .94;
    typeContext.fillRect(x + dx, y + dy, size, size);
  }
  typeContext.globalAlpha = 1;
}

function drawType(now) {
  if (!typeContext) return;
  typeContext.fillStyle = '#000';
  typeContext.fillRect(0, 0, width, height);
  if (!transition) {
    drawHeadline(typeContext, slides[index]);
    return;
  }
  const progress = clamp((now - transition.start) / transition.duration);
  const { from, outgoing, incoming, direction } = transition;
  if (from && progress < .28) {
    typeContext.globalAlpha = 1 - ease(progress / .28);
    drawHeadline(typeContext, from);
  }
  if (outgoing) drawParticles(outgoing, progress * 1.72, direction, false);
  drawParticles(incoming, progress * 1.3 - (outgoing ? .23 : 0), direction, true);
  typeContext.globalAlpha = ease(clamp((progress - .52) / .48));
  drawHeadline(typeContext, slides[index]);
  typeContext.globalAlpha = 1;
  if (progress === 1) transition = undefined;
}

function wake() {
  if (!frame && visible && !document.hidden && !hero.closest('[hidden]')) {
    frame = requestAnimationFrame(render);
  }
}

function render(now) {
  frame = 0;
  if (!visible || document.hidden || hero.closest('[hidden]')) {
    lastTime = 0;
    return;
  }
  const dt = lastTime ? Math.min((now - lastTime) / 1000, .05) : 1 / 60;
  lastTime = now;
  const changing = Boolean(transition);
  if (changing) drawType(now);
  glass?.render(dt, now, changing);
  if (transition || (glass && !reduced.matches)) wake();
}

function layout() {
  if (!hero.clientWidth || !hero.clientHeight) return;
  width = hero.clientWidth;
  height = hero.clientHeight;
  ratio = Math.min(devicePixelRatio || 1, width < 740 ? 1.25 : 1.6);
  if (typeContext) {
    typeCanvas.width = Math.round(width * ratio);
    typeCanvas.height = Math.round(height * ratio);
    typeContext.setTransform(typeCanvas.width / width, 0, 0, typeCanvas.height / height, 0, 0);
    poster.hidden = true;
    transition = undefined;
    drawType(performance.now());
  }
  glass?.layout(width, height, ratio);
  wake();
}

function showSlide(next, direction) {
  if (next === index) return;
  const from = slides[index];
  const outgoing = typeContext && width && height && !reduced.matches ? sampleHeadline(from) : null;
  index = next;
  const lines = slides[index];
  title.textContent = lines.join('');
  poster.replaceChildren(lines[0], document.createElement('br'), lines[1]);
  dots.forEach((dot, position) => {
    if (position === index) dot.setAttribute('aria-current', 'true');
    else dot.removeAttribute('aria-current');
  });
  if (outgoing) {
    transition = { from, outgoing, incoming: sampleHeadline(lines), direction, start: performance.now(), duration: 840 };
  } else {
    transition = undefined;
    if (width && height) drawType(performance.now());
    glass?.refreshType();
  }
  glass?.turn(direction);
  wake();
}

document.getElementById('home-prev').addEventListener('click', () => showSlide((index + slides.length - 1) % slides.length, -1));
document.getElementById('home-next').addEventListener('click', () => showSlide((index + 1) % slides.length, 1));
dots.forEach((dot, position) => dot.addEventListener('click', () => showSlide(position, position > index ? 1 : -1)));

new ResizeObserver(layout).observe(hero);
new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting;
  if (visible) wake();
}).observe(hero);
document.addEventListener('visibilitychange', wake);
reduced.addEventListener('change', () => {
  transition = undefined;
  drawType(performance.now());
  glass?.refreshType();
  wake();
});

async function mountGlass() {
  if (!typeContext) return;
  try {
    const { createGlass } = await import('./home-glass.js');
    glass = createGlass(glassCanvas, typeCanvas, reduced, wake);
    glassCanvas.hidden = false;
    layout();
  } catch {
    glassCanvas.hidden = true;
  }
}

layout();
if (document.fonts) {
  document.fonts.ready.then(() => {
    if (!hero.clientWidth) return;
    layout();
    if (!reduced.matches && visible) {
      transition = { incoming: sampleHeadline(slides[index]), direction: 1, start: performance.now(), duration: 760 };
      wake();
    }
  });
}
mountGlass();
