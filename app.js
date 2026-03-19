// Noise Generator — ultra-minimal interface.
//
// Black screen with a colored dot. Dragging reveals a spectrum analyzer,
// grid overlay, and info HUD. Trail of past positions fades in while dragging.
// Double-tap resets the listening timer.

const STATE_KEY = 'noiseGeneratorState';
const MAX_TRAIL = 10;
const OVERLAY_FADE_RATE = 0.08; // interpolation factor for overlay fade (0–1)
const FADE_DURATION = 0.5;      // audio fade in/out in seconds
const HUD_LINGER_MS = 800;      // how long HUD stays after releasing drag
const DOUBLE_TAP_MS = 350;      // max interval for double-tap detection
const TIMER_SAVE_INTERVAL = 10; // save timer to localStorage every N seconds

// ─── Responsive sizing ───────────────────────────────────────────────────────

// Detect touch device for scaling (coarse pointer = finger, not mouse)
function isTouchDevice() {
  return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
}

// Scale factor: 3x on touch/mobile, 1x on desktop
function uiScale() {
  return isTouchDevice() ? 3 : 1;
}

// Base sizes (desktop), multiplied by uiScale() when used
const BASE_DOT_RADIUS = 18;
const BASE_LABEL_FONT = 11;
const BASE_FREQ_LABEL_FONT = 11;

function dotRadius()  { return BASE_DOT_RADIUS * uiScale(); }
function labelFont()  { return BASE_LABEL_FONT * uiScale(); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Normalized position (0–1) → frequency in Hz (logarithmic 20–20000)
function normToFreq(x) {
  return 20 * Math.pow(1000, x);
}

// Frequency in Hz → normalized position (0–1)
function freqToNorm(freq) {
  return Math.log(freq / 20) / Math.log(1000);
}

// Format seconds as HH:MM:SS
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

// Human-readable frequency label
function formatFreq(x) {
  const freq = normToFreq(x);
  return freq >= 1000 ? `${(freq / 1000).toFixed(1)}kHz` : `${Math.round(freq)}Hz`;
}

// Find which segment a value falls into within a sorted array of { pos, ... }.
// Returns { lower, upper, t } where t is the interpolation factor (0–1).
function findSegment(value, stops) {
  for (let i = 0; i < stops.length - 1; i++) {
    if (value <= stops[i + 1].pos) {
      const lower = stops[i];
      const upper = stops[i + 1];
      const t = (value - lower.pos) / (upper.pos - lower.pos);
      return { lower, upper, t };
    }
  }
  return { lower: stops[stops.length - 2], upper: stops[stops.length - 1], t: 1 };
}

function rgbString(r, g, b, a = 1) {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ─── Noise type definitions ──────────────────────────────────────────────────

// Used for both color mapping and display labels.
// pos: normalized Y position (0 = bottom, 1 = top)
const NOISE_TYPES = [
  { pos: 0.0,  name: 'Brown',  r: 140, g: 70,  b: 20  },
  { pos: 0.25, name: 'Pink',   r: 200, g: 80,  b: 120 },
  { pos: 0.5,  name: 'White',  r: 180, g: 180, b: 190 },
  { pos: 0.75, name: 'Blue',   r: 40,  g: 120, b: 220 },
  { pos: 1.0,  name: 'Violet', r: 130, g: 50,  b: 220 },
];

// Get the dot color for a given XY position.
// Y selects hue from noise type palette, X modulates brightness.
function colorForPosition(x, y) {
  const { lower, upper, t } = findSegment(y, NOISE_TYPES);
  const brightness = 0.5 + x * 0.5;
  return {
    r: Math.round((lower.r + (upper.r - lower.r) * t) * brightness),
    g: Math.round((lower.g + (upper.g - lower.g) * t) * brightness),
    b: Math.round((lower.b + (upper.b - lower.b) * t) * brightness),
  };
}

// Human-readable noise type name for a Y position.
function noiseTypeName(y) {
  const { lower, upper, t } = findSegment(y, NOISE_TYPES);
  if (t < 0.15) return lower.name;
  if (t > 0.85) return upper.name;
  return `${lower.name}–${upper.name}`;
}

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  ballX: 0.5,          // normalized 0–1 → filter frequency
  ballY: 0.5,          // normalized 0–1 → noise type
  playing: false,
  timerSeconds: 0,
  audioInitialized: false,
};

let trailDots = []; // array of { x, y } — past ball positions

// ─── Audio engine ────────────────────────────────────────────────────────────

let audioCtx = null;
let workletNode = null;
let analyser = null;
let fadeGain = null;
let freqData = null;         // raw Uint8Array from analyser
let smoothedSpectrum = null; // smoothed Float32Array for display
let audioReady = false;      // true once worklet is loaded and connected

// Step 1: Create AudioContext synchronously inside the user gesture.
// This MUST happen synchronously in the event handler — if we await anything
// before creating/resuming the context, mobile browsers drop the gesture.
function createAudioContext() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AC();

  // On iOS, playing a silent buffer helps unlock audio in silent mode
  try {
    const silentBuffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    src.buffer = silentBuffer;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch {}

  // Resume immediately while we still have the user gesture
  audioCtx.resume();
}

// Step 2: Load the AudioWorklet module and wire up nodes (async, runs after gesture).
async function initAudioWorklet() {
  if (audioReady) return;
  try {
    await audioCtx.audioWorklet.addModule('noise-processor.js');

    workletNode = new AudioWorkletNode(audioCtx, 'noise-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    smoothedSpectrum = new Float32Array(analyser.frequencyBinCount);

    fadeGain = audioCtx.createGain();
    fadeGain.gain.value = 0;

    workletNode.connect(analyser);
    analyser.connect(fadeGain);
    fadeGain.connect(audioCtx.destination);

    audioReady = true;
    syncAudioParams();
    play();
    setupMediaSession();
  } catch (err) {
    console.error('Failed to init AudioWorklet:', err);
  }
}

function syncAudioParams() {
  if (!workletNode) return;
  const now = audioCtx.currentTime;
  workletNode.parameters.get('filterFreq').setTargetAtTime(normToFreq(state.ballX), now, 0.02);
  workletNode.parameters.get('noiseType').setTargetAtTime(state.ballY, now, 0.02);
  workletNode.parameters.get('gain').setTargetAtTime(0.8, now, 0.02);
}

// Smoothly ramp master gain to a target value over FADE_DURATION seconds.
function rampGainTo(target) {
  if (!fadeGain) return;
  const now = audioCtx.currentTime;
  fadeGain.gain.cancelScheduledValues(now);
  fadeGain.gain.setValueAtTime(fadeGain.gain.value, now);
  fadeGain.gain.linearRampToValueAtTime(target, now + FADE_DURATION);
}

// ─── Play / pause ────────────────────────────────────────────────────────────

function play() {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  rampGainTo(1);
  state.playing = true;
  startTimer();
  syncMediaSession();
}

function pause() {
  if (!audioCtx) return;
  rampGainTo(0);
  setTimeout(() => audioCtx.suspend(), (FADE_DURATION + 0.05) * 1000);
  state.playing = false;
  stopTimer();
  syncMediaSession();
}

// ─── Timer ───────────────────────────────────────────────────────────────────

let timerInterval = null;
let lastTimerSave = 0;

function startTimer() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    state.timerSeconds++;
    document.getElementById('timer').textContent = formatTime(state.timerSeconds);
    if (state.timerSeconds - lastTimerSave >= TIMER_SAVE_INTERVAL) {
      lastTimerSave = state.timerSeconds;
      saveState();
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ─── MediaSession (mobile lock-screen controls) ──────────────────────────────

function syncMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: `${noiseTypeName(state.ballY)} Noise`,
    artist: 'Noise Generator',
    album: 'Ambient Noise',
  });
  navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', pause);
  syncMediaSession();
}

// ─── State persistence (localStorage) ────────────────────────────────────────

function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      ballX: state.ballX,
      ballY: state.ballY,
      timerSeconds: state.timerSeconds,
      trail: trailDots,
    }));
  } catch {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (typeof saved.ballX === 'number') state.ballX = saved.ballX;
    if (typeof saved.ballY === 'number') state.ballY = saved.ballY;
    if (typeof saved.timerSeconds === 'number') state.timerSeconds = saved.timerSeconds;
    if (Array.isArray(saved.trail)) trailDots = saved.trail.slice(0, MAX_TRAIL);
  } catch {}
}

// ─── Canvas setup ────────────────────────────────────────────────────────────

let canvas, ctx, canvasW, canvasH;

function resizeCanvas() {
  const dpr = devicePixelRatio;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  canvasW = canvas.width;
  canvasH = canvas.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Logical (CSS) dimensions of the canvas
function logicalSize() {
  return { w: canvasW / devicePixelRatio, h: canvasH / devicePixelRatio };
}

// Convert ball position (normalized 0–1) to pixel coordinates
function ballToPixel(x, y) {
  const { w, h } = logicalSize();
  return { px: x * w, py: (1 - y) * h };
}

// ─── Drawing: spectrum analyzer ──────────────────────────────────────────────

function drawSpectrum(alpha) {
  if (!analyser || !state.playing || alpha <= 0.001) return;

  const { w, h } = logicalSize();
  analyser.getByteFrequencyData(freqData);

  const binCount = analyser.frequencyBinCount;
  const nyquist = audioCtx.sampleRate / 2;
  const { r, g, b } = colorForPosition(state.ballX, state.ballY);
  const numBars = Math.min(Math.floor(w / 2), 200);

  ctx.save();
  for (let i = 0; i < numBars; i++) {
    const normLeft = i / numBars;
    const normRight = (i + 1) / numBars;
    const freqLow = normToFreq(normLeft);
    const freqHigh = normToFreq(normRight);

    // Average FFT bins that fall in this frequency range
    const binLow = Math.floor(freqLow / nyquist * binCount);
    const binHigh = Math.max(binLow + 1, Math.ceil(freqHigh / nyquist * binCount));
    let sum = 0, count = 0;
    for (let bin = Math.max(0, binLow); bin < Math.min(binCount, binHigh); bin++) {
      sum += freqData[bin];
      count++;
    }
    const magnitude = count > 0 ? sum / count / 255 : 0;

    // Smooth for display
    const smoothIdx = Math.min(binLow, smoothedSpectrum.length - 1);
    if (smoothIdx >= 0) {
      smoothedSpectrum[smoothIdx] = smoothedSpectrum[smoothIdx] * 0.7 + magnitude * 0.3;
    }
    const value = smoothIdx >= 0 ? smoothedSpectrum[smoothIdx] : magnitude;

    const barX = normLeft * w;
    const barW = (normRight - normLeft) * w + 0.5; // +0.5 avoids sub-pixel gaps
    const barH = value * h * 0.85;
    if (barH < 0.5) continue;

    const grad = ctx.createLinearGradient(0, h, 0, h - barH);
    grad.addColorStop(0,   rgbString(r, g, b, 0));                    // fade out at bottom
    grad.addColorStop(0.1, rgbString(r, g, b, value * 1.0 * alpha));  // peak near base
    grad.addColorStop(0.5, rgbString(r, g, b, value * 0.7 * alpha));
    grad.addColorStop(1,   rgbString(r, g, b, value * 0.1 * alpha));  // fade out at top
    ctx.fillStyle = grad;
    ctx.fillRect(barX, h - barH, barW, barH);
  }
  ctx.restore();
}

// ─── Drawing: grid and labels ────────────────────────────────────────────────

function drawGrid(alpha) {
  if (alpha <= 0.001) return;
  const { w, h } = logicalSize();
  const fontSize = labelFont();

  ctx.save();
  ctx.globalAlpha = alpha;

  // Horizontal lines at noise type boundaries
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  for (const { pos } of NOISE_TYPES) {
    const y = h - pos * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Vertical lines at frequency landmarks
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  for (const freq of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = freqToNorm(freq) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }

  // Noise type labels (left edge)
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.textAlign = 'left';
  for (const { pos, name } of NOISE_TYPES) {
    ctx.fillText(name, 10, h - pos * h - 6);
  }

  // Frequency labels (bottom edge)
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  for (const [freq, label] of [[100, '100Hz'], [1000, '1kHz'], [10000, '10kHz']]) {
    ctx.fillText(label, freqToNorm(freq) * w, h - 10);
  }

  ctx.restore();
}

// ─── Drawing: crosshair ──────────────────────────────────────────────────────

function drawCrosshair(alpha) {
  if (alpha <= 0.001) return;
  const { w, h } = logicalSize();
  const { px, py } = ballToPixel(state.ballX, state.ballY);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 8]);
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ─── Drawing: dots (active + trail) ──────────────────────────────────────────

function drawDot(x, y, alpha, radius) {
  const { r, g, b } = colorForPosition(x, y);
  const { px, py } = ballToPixel(x, y);

  ctx.save();
  ctx.globalAlpha = alpha;

  // Glow
  ctx.shadowColor = rgbString(r, g, b);
  ctx.shadowBlur = radius * 3;
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.fillStyle = rgbString(r, g, b);
  ctx.fill();

  // Bright center
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(px, py, radius * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = rgbString(r, g, b, 0.8);
  ctx.fill();

  ctx.restore();
}

function drawTrailDots(alpha) {
  if (alpha <= 0.001) return;
  const radius = dotRadius();
  for (let i = 0; i < trailDots.length; i++) {
    const dot = trailDots[i];
    const ageRatio = (i + 1) / (trailDots.length + 1); // 0→1, newer = higher
    drawDot(dot.x, dot.y, ageRatio * 0.35 * alpha, radius * (0.6 + ageRatio * 0.4));
  }
}

function drawActiveDot() {
  const radius = dotRadius();
  const alpha = dragging ? 1.0 : 0.7;
  const r = dragging ? radius + 4 : radius;
  drawDot(state.ballX, state.ballY, alpha, r);
}

// ─── Render loop ─────────────────────────────────────────────────────────────

let dragging = false;
let overlayAlpha = 0; // smoothed 0–1, controls visibility of grid/spectrum/trail/HUD

function render() {
  const { w, h } = logicalSize();

  // Smoothly animate overlay alpha toward target
  const target = dragging ? 1 : 0;
  overlayAlpha += (target - overlayAlpha) * OVERLAY_FADE_RATE;
  if (Math.abs(overlayAlpha - target) < 0.005) overlayAlpha = target;

  // Black background
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  // Layers (back to front)
  drawSpectrum(overlayAlpha);
  drawGrid(overlayAlpha);
  drawCrosshair(overlayAlpha);
  drawTrailDots(overlayAlpha);
  drawActiveDot();

  requestAnimationFrame(render);
}

// ─── Trail management ────────────────────────────────────────────────────────

function pushTrailDot() {
  const last = trailDots[trailDots.length - 1];
  // Skip if barely moved
  if (last && Math.abs(last.x - state.ballX) < 0.01 && Math.abs(last.y - state.ballY) < 0.01) return;
  trailDots.push({ x: state.ballX, y: state.ballY });
  if (trailDots.length > MAX_TRAIL) trailDots.shift();
}

// ─── Input handling ──────────────────────────────────────────────────────────

let hudFadeTimeout = null;
let lastTapTime = 0;

function showHud() {
  clearTimeout(hudFadeTimeout);
  document.getElementById('hud')?.classList.add('visible');
}

function hideHud() {
  hudFadeTimeout = setTimeout(() => {
    document.getElementById('hud')?.classList.remove('visible');
  }, HUD_LINGER_MS);
}

function updateHud() {
  document.getElementById('noiseType').textContent = `${noiseTypeName(state.ballY)} Noise`;
  document.getElementById('noiseFreq').textContent = formatFreq(state.ballX);
}

function screenToNorm(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height)),
  };
}

function onPointerDown(clientX, clientY) {
  // On first interaction: create AudioContext SYNCHRONOUSLY (preserves user gesture),
  // then load the worklet async. This is critical for mobile browsers.
  if (!state.audioInitialized) {
    state.audioInitialized = true;
    createAudioContext();
    // Worklet loading is async — audio starts once it's ready
    initAudioWorklet();
  }

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
  syncMediaSession();
}

function onDoubleTap() {
  state.timerSeconds = 0;
  document.getElementById('timer').textContent = formatTime(0);
  saveState();
}

function setupInput() {
  // Mouse
  canvas.addEventListener('mousedown', e => onPointerDown(e.clientX, e.clientY));
  window.addEventListener('mousemove', e => onPointerMove(e.clientX, e.clientY));
  window.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('dblclick', e => { e.preventDefault(); onDoubleTap(); });

  // Touch
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

// ─── Init ────────────────────────────────────────────────────────────────────

function init() {
  loadState();

  canvas = document.getElementById('noisePad');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  setupInput();
  document.getElementById('timer').textContent = formatTime(state.timerSeconds);
  updateHud();

  requestAnimationFrame(render);
}

document.addEventListener('DOMContentLoaded', init);
