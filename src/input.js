// Input handling: mouse, touch, HUD visibility, double-tap.

import { DOUBLE_TAP_MS, HUD_LINGER_MS } from './constants.js';
import { noiseTypeName, formatFreq, formatTime } from './helpers.js';
import { state, saveState, pushTrailDot } from './state.js';
import { resumeAudioContext, syncAudioParams, play, audioReady } from './audio.js';
import { getCanvas } from './canvas.js';

let hudFadeTimeout = null;
let lastTapTime = 0;

// These are exported as live bindings — render loop reads them directly.
export let dragging = false;
export let introPeekActive = false;

function showHud() {
  clearTimeout(hudFadeTimeout);
  document.getElementById('hud')?.classList.add('visible');
}

function hideHud() {
  hudFadeTimeout = setTimeout(() => {
    document.getElementById('hud')?.classList.remove('visible');
  }, HUD_LINGER_MS);
}

export function updateHud() {
  document.getElementById('noiseType').textContent = `${noiseTypeName(state.ballY)} Noise`;
  document.getElementById('noiseFreq').textContent = formatFreq(state.ballX);
}

function screenToNorm(clientX, clientY) {
  const rect = getCanvas().getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height)),
  };
}

function onPointerDown(clientX, clientY) {
  introPeekActive = false;

  // Resume AudioContext synchronously in gesture — this is what unlocks
  // audio on mobile. Everything is already loaded eagerly on page load.
  resumeAudioContext();
  if (audioReady && !state.playing) play();

  dragging = true;
  const { x, y } = screenToNorm(clientX, clientY);
  state.ballX = x;
  state.ballY = y;
  syncAudioParams();
  updateHud();
  document.getElementById('timer').textContent = formatTime(state.timerSeconds);
  showHud();
}

function onPointerMove(clientX, clientY) {
  if (!dragging) return;
  const { x, y } = screenToNorm(clientX, clientY);
  state.ballX = x;
  state.ballY = y;
  syncAudioParams();
  updateHud();
}

function onPointerUp() {
  if (!dragging) return;
  dragging = false;
  pushTrailDot();
  hideHud();
  saveState();
}

function onDoubleTap() {
  state.timerSeconds = 0;
  document.getElementById('timer').textContent = formatTime(0);
  saveState();
}

export function setupInput() {
  const canvas = getCanvas();

  canvas.addEventListener('mousedown', e => onPointerDown(e.clientX, e.clientY));
  window.addEventListener('mousemove', e => onPointerMove(e.clientX, e.clientY));
  window.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('dblclick', e => { e.preventDefault(); onDoubleTap(); });

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastTapTime < DOUBLE_TAP_MS) onDoubleTap();
    lastTapTime = now;
    onPointerDown(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    onPointerUp();
  }, { passive: false });
}

export function startIntroPeek() {
  introPeekActive = true;
  showHud();
  updateHud();
  document.getElementById('timer').textContent = formatTime(state.timerSeconds);

  setTimeout(() => {
    if (!dragging) {
      introPeekActive = false;
      hideHud();
    }
  }, 1500);
}
