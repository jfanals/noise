// Main entry point — wires up modules and runs the render loop.

import { VERSION, OVERLAY_FADE_RATE } from './src/constants.js';
import { state } from './src/state.js';
import { loadState } from './src/state.js';
import { initCanvas, getCtx, logicalSize } from './src/canvas.js';
import { drawSpectrum, drawGrid, drawCrosshair, drawTrailDots, drawActiveDot } from './src/draw.js';
import { setupInput, startIntroPeek, dragging, introPeekActive } from './src/input.js';
import { formatTime } from './src/helpers.js';
import { initAudioEagerly } from './src/audio.js';

let overlayAlpha = 0;

function render() {
  const ctx = getCtx();
  const { w, h } = logicalSize();

  // Import live values (ES module exports are live bindings)
  const target = (dragging || introPeekActive) ? 1 : 0;
  overlayAlpha += (target - overlayAlpha) * OVERLAY_FADE_RATE;
  if (Math.abs(overlayAlpha - target) < 0.005) overlayAlpha = target;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  drawSpectrum(overlayAlpha);
  drawGrid(overlayAlpha);
  drawCrosshair(overlayAlpha);
  drawTrailDots(overlayAlpha);
  drawActiveDot(dragging);

  requestAnimationFrame(render);
}

function init() {
  loadState();
  document.getElementById('version').textContent = VERSION;

  initCanvas();
  setupInput();

  // Load AudioContext + worklet eagerly (context starts suspended).
  // First user touch will just call resume() — no async delay.
  initAudioEagerly();

  document.getElementById('timer').textContent = formatTime(state.timerSeconds);
  requestAnimationFrame(render);
  startIntroPeek();
}

document.addEventListener('DOMContentLoaded', init);
