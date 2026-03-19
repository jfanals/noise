// Canvas setup and coordinate helpers.

let canvas, ctx, canvasW, canvasH;

export function getCanvas() { return canvas; }
export function getCtx() { return ctx; }

export function initCanvas() {
  canvas = document.getElementById('noisePad');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

export function resizeCanvas() {
  const dpr = devicePixelRatio;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  canvasW = canvas.width;
  canvasH = canvas.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function logicalSize() {
  return { w: canvasW / devicePixelRatio, h: canvasH / devicePixelRatio };
}

export function ballToPixel(x, y) {
  const { w, h } = logicalSize();
  return { px: x * w, py: (1 - y) * h };
}
