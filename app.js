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
const INTRO_PEEK_MS = 1500;     // how long the initial UI peek lasts

// ─── Responsive sizing ───────────────────────────────────────────────────────

function isTouchDevice() {
  return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
}

function uiScale() { return isTouchDevice() ? 3 : 1; }

const BASE_DOT_RADIUS = 18;
const BASE_LABEL_FONT = 11;

function dotRadius()  { return BASE_DOT_RADIUS * uiScale(); }
function labelFont()  { return BASE_LABEL_FONT * uiScale(); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normToFreq(x) { return 20 * Math.pow(1000, x); }
function freqToNorm(freq) { return Math.log(freq / 20) / Math.log(1000); }

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function formatFreq(x) {
  const freq = normToFreq(x);
  return freq >= 1000 ? `${(freq / 1000).toFixed(1)}kHz` : `${Math.round(freq)}Hz`;
}

function findSegment(value, stops) {
  for (let i = 0; i < stops.length - 1; i++) {
    if (value <= stops[i + 1].pos) {
      const lower = stops[i], upper = stops[i + 1];
      return { lower, upper, t: (value - lower.pos) / (upper.pos - lower.pos) };
    }
  }
  return { lower: stops[stops.length - 2], upper: stops[stops.length - 1], t: 1 };
}

function rgbString(r, g, b, a = 1) { return `rgba(${r}, ${g}, ${b}, ${a})`; }

// ─── Noise type definitions ──────────────────────────────────────────────────

const NOISE_TYPES = [
  { pos: 0.0,  name: 'Brown',  r: 140, g: 70,  b: 20  },
  { pos: 0.25, name: 'Pink',   r: 200, g: 80,  b: 120 },
  { pos: 0.5,  name: 'White',  r: 180, g: 180, b: 190 },
  { pos: 0.75, name: 'Blue',   r: 40,  g: 120, b: 220 },
  { pos: 1.0,  name: 'Violet', r: 130, g: 50,  b: 220 },
];

function colorForPosition(x, y) {
  const { lower, upper, t } = findSegment(y, NOISE_TYPES);
  const brightness = 0.5 + x * 0.5;
  return {
    r: Math.round((lower.r + (upper.r - lower.r) * t) * brightness),
    g: Math.round((lower.g + (upper.g - lower.g) * t) * brightness),
    b: Math.round((lower.b + (upper.b - lower.b) * t) * brightness),
  };
}

function noiseTypeName(y) {
  const { lower, upper, t } = findSegment(y, NOISE_TYPES);
  if (t < 0.15) return lower.name;
  if (t > 0.85) return upper.name;
  return `${lower.name}–${upper.name}`;
}

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  ballX: 0.5,
  ballY: 0.5,
  playing: false,
  timerSeconds: 0,
  audioInitialized: false,
};

let trailDots = [];

// ─── Audio engine ────────────────────────────────────────────────────────────

let audioCtx = null;
let workletNode = null;
let scriptNode = null;  // ScriptProcessorNode fallback
let analyser = null;
let fadeGain = null;
let freqData = null;
let smoothedSpectrum = null;
let audioReady = false;

// Create AudioContext synchronously inside user gesture — critical for mobile.
function createAudioContext() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AC();

  // iOS silent mode workaround: play a silent buffer to unlock audio output
  try {
    const buf = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch {}

  audioCtx.resume();
}

// Try AudioWorklet first, fall back to ScriptProcessorNode.
// AudioWorklet requires a secure context (HTTPS) on mobile browsers.
async function initAudioNodes() {
  if (audioReady) return;

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  freqData = new Uint8Array(analyser.frequencyBinCount);
  smoothedSpectrum = new Float32Array(analyser.frequencyBinCount);

  fadeGain = audioCtx.createGain();
  fadeGain.gain.value = 0;
  analyser.connect(fadeGain);
  fadeGain.connect(audioCtx.destination);

  // Try AudioWorklet (modern, runs on audio thread)
  try {
    if (!audioCtx.audioWorklet) throw new Error('AudioWorklet not supported');
    await audioCtx.audioWorklet.addModule('noise-processor.js');
    workletNode = new AudioWorkletNode(audioCtx, 'noise-processor', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    workletNode.connect(analyser);
    console.log('Audio: using AudioWorklet');
  } catch (err) {
    console.warn('AudioWorklet failed, using ScriptProcessor fallback:', err);
    initScriptProcessorFallback();
  }

  audioReady = true;
  syncAudioParams();
  play();
  setupMediaSession();
}

// ─── ScriptProcessorNode fallback (for HTTP / older browsers) ────────────────

function initScriptProcessorFallback() {
  const BUFFER_SIZE = 2048;
  scriptNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 2);

  // Per-channel noise state (mirrors noise-processor.js logic)
  const NUM_PINK_STAGES = 7;
  const channels = [null, null];

  function makeChannel() {
    return {
      brown: 0,
      pinkRows: new Float64Array(NUM_PINK_STAGES), pinkRunningSum: 0, pinkIndex: 0,
      bluePrev: 0, violetPrev1: 0, violetPrev2: 0, lpState: 0,
    };
  }

  let hasSpare = false, spare = 0;
  function gaussian() {
    if (hasSpare) { hasSpare = false; return spare; }
    let u, v, s;
    do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; }
    while (s >= 1 || s === 0);
    const mul = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * mul; hasSpare = true;
    return u * mul;
  }

  function genBrown(cs)  { const w = gaussian(); cs.brown = cs.brown * 0.998 + w * 0.05; return cs.brown * 3.5; }
  function genWhite()     { return gaussian(); }
  function genBlue(cs)    { const w = gaussian(); const o = w - cs.bluePrev; cs.bluePrev = w; return o * 0.7; }
  function genViolet(cs)  { const w = gaussian(); const o = w - 2 * cs.violetPrev1 + cs.violetPrev2; cs.violetPrev2 = cs.violetPrev1; cs.violetPrev1 = w; return o * 0.5; }

  function genPink(cs) {
    const idx = cs.pinkIndex++;
    let numZeros = 0;
    if (idx !== 0) { let n = idx; while ((n & 1) === 0) { numZeros++; n >>= 1; } }
    if (numZeros < NUM_PINK_STAGES) {
      cs.pinkRunningSum -= cs.pinkRows[numZeros];
      const r = gaussian(); cs.pinkRows[numZeros] = r; cs.pinkRunningSum += r;
    }
    return (cs.pinkRunningSum + gaussian()) / Math.sqrt(NUM_PINK_STAGES + 1);
  }

  const generators = [genBrown, genPink, genWhite, genBlue, genViolet];

  function genNoise(cs, noiseType) {
    const scaled = noiseType * 4;
    const seg = Math.min(Math.floor(scaled), 3);
    const blend = scaled - seg;
    return generators[seg](cs) * (1 - blend) + generators[seg + 1](cs) * blend;
  }

  scriptNode.onaudioprocess = function(e) {
    const L = e.outputBuffer.getChannelData(0);
    const R = e.outputBuffer.getChannelData(1);
    const len = L.length;
    const gain = 0.8;
    const noiseType = state.ballY;
    const filterFreq = normToFreq(state.ballX);
    const omega = 2 * Math.PI * filterFreq / audioCtx.sampleRate;
    const alpha = omega / (omega + 1);

    for (let ch = 0; ch < 2; ch++) {
      if (!channels[ch]) channels[ch] = makeChannel();
      const cs = channels[ch];
      const buf = ch === 0 ? L : R;
      for (let i = 0; i < len; i++) {
        let sample = Math.tanh(genNoise(cs, noiseType));
        cs.lpState += alpha * (sample - cs.lpState);
        buf[i] = cs.lpState * gain;
      }
    }

    // Stereo decorrelation
    const cross = 0.05, direct = 0.95;
    for (let i = 0; i < len; i++) {
      const l = L[i], r = R[i];
      L[i] = l * direct + r * cross;
      R[i] = r * direct + l * cross;
    }
  };

  scriptNode.connect(analyser);
}

function syncAudioParams() {
  if (!workletNode) return; // ScriptProcessor reads state directly
  const now = audioCtx.currentTime;
  workletNode.parameters.get('filterFreq').setTargetAtTime(normToFreq(state.ballX), now, 0.02);
  workletNode.parameters.get('noiseType').setTargetAtTime(state.ballY, now, 0.02);
  workletNode.parameters.get('gain').setTargetAtTime(0.8, now, 0.02);
}

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
      ballX: state.ballX, ballY: state.ballY,
      timerSeconds: state.timerSeconds, trail: trailDots,
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

function logicalSize() {
  return { w: canvasW / devicePixelRatio, h: canvasH / devicePixelRatio };
}

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

    const binLow = Math.floor(freqLow / nyquist * binCount);
    const binHigh = Math.max(binLow + 1, Math.ceil(freqHigh / nyquist * binCount));
    let sum = 0, count = 0;
    for (let bin = Math.max(0, binLow); bin < Math.min(binCount, binHigh); bin++) {
      sum += freqData[bin]; count++;
    }
    const magnitude = count > 0 ? sum / count / 255 : 0;

    const smoothIdx = Math.min(binLow, smoothedSpectrum.length - 1);
    if (smoothIdx >= 0)
      smoothedSpectrum[smoothIdx] = smoothedSpectrum[smoothIdx] * 0.7 + magnitude * 0.3;
    const value = smoothIdx >= 0 ? smoothedSpectrum[smoothIdx] : magnitude;

    const barX = normLeft * w;
    const barW = (normRight - normLeft) * w + 0.5;
    const barH = value * h * 0.85;
    if (barH < 0.5) continue;

    const grad = ctx.createLinearGradient(0, h, 0, h - barH);
    grad.addColorStop(0,   rgbString(r, g, b, 0));
    grad.addColorStop(0.1, rgbString(r, g, b, value * 1.0 * alpha));
    grad.addColorStop(0.5, rgbString(r, g, b, value * 0.7 * alpha));
    grad.addColorStop(1,   rgbString(r, g, b, value * 0.1 * alpha));
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

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  for (const { pos } of NOISE_TYPES) {
    const y = h - pos * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  for (const freq of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = freqToNorm(freq) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }

  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.textAlign = 'left';
  for (const { pos, name } of NOISE_TYPES)
    ctx.fillText(name, 10, h - pos * h - 6);

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  for (const [freq, label] of [[100, '100Hz'], [1000, '1kHz'], [10000, '10kHz']])
    ctx.fillText(label, freqToNorm(freq) * w, h - 10);

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

  ctx.shadowColor = rgbString(r, g, b);
  ctx.shadowBlur = radius * 3;
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.fillStyle = rgbString(r, g, b);
  ctx.fill();

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
    const ageRatio = (i + 1) / (trailDots.length + 1);
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
let introPeekActive = false; // true during the initial UI peek on load
let overlayAlpha = 0;

function render() {
  const { w, h } = logicalSize();

  const target = (dragging || introPeekActive) ? 1 : 0;
  overlayAlpha += (target - overlayAlpha) * OVERLAY_FADE_RATE;
  if (Math.abs(overlayAlpha - target) < 0.005) overlayAlpha = target;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

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
  // Cancel the intro peek if user interacts early
  introPeekActive = false;

  // Create AudioContext SYNCHRONOUSLY in gesture handler (critical for mobile)
  if (!state.audioInitialized) {
    state.audioInitialized = true;
    createAudioContext();
    initAudioNodes(); // async, but AudioContext is already alive
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

// ─── Intro peek: briefly show UI on load ─────────────────────────────────────

function startIntroPeek() {
  introPeekActive = true;
  showHud();
  updateHud();
  document.getElementById('timer').textContent = formatTime(state.timerSeconds);

  setTimeout(() => {
    // Only end peek if user hasn't started dragging
    if (!dragging) {
      introPeekActive = false;
      hideHud();
    }
  }, INTRO_PEEK_MS);
}

// ─── Init ────────────────────────────────────────────────────────────────────

function init() {
  loadState();

  canvas = document.getElementById('noisePad');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  setupInput();
  requestAnimationFrame(render);

  // Brief glimpse of the full UI on first load
  startIntroPeek();
}

document.addEventListener('DOMContentLoaded', init);
