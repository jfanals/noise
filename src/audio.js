import { VERSION, FADE_DURATION, TIMER_SAVE_INTERVAL } from './constants.js';
import { normToFreq, noiseTypeName, formatTime } from './helpers.js';
import { state, saveState } from './state.js';

// ─── Audio state ─────────────────────────────────────────────────────────────

export let audioCtx = null;
let workletNode = null;
let scriptNode = null;

export let analyser = null;
export let fadeGain = null;
export let freqData = null;
export let smoothedSpectrum = null;
export let audioReady = false;

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

export function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', pause);
  syncMediaSession();
}

// ─── Gain control ────────────────────────────────────────────────────────────

function rampGainTo(target) {
  if (!fadeGain) return;
  const now = audioCtx.currentTime;
  fadeGain.gain.cancelScheduledValues(now);
  fadeGain.gain.setValueAtTime(fadeGain.gain.value, now);
  fadeGain.gain.linearRampToValueAtTime(target, now + FADE_DURATION);
}

// ─── Play / pause ────────────────────────────────────────────────────────────

export function play() {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  rampGainTo(1);
  state.playing = true;
  startTimer();
  syncMediaSession();
}

export function pause() {
  if (!audioCtx) return;
  rampGainTo(0);
  setTimeout(() => audioCtx.suspend(), (FADE_DURATION + 0.05) * 1000);
  state.playing = false;
  stopTimer();
  syncMediaSession();
}

// ─── Param sync ──────────────────────────────────────────────────────────────

export function syncAudioParams() {
  if (!workletNode) return; // ScriptProcessor reads state directly
  const now = audioCtx.currentTime;
  workletNode.parameters.get('filterFreq').setTargetAtTime(normToFreq(state.ballX), now, 0.02);
  workletNode.parameters.get('noiseType').setTargetAtTime(state.ballY, now, 0.02);
  workletNode.parameters.get('gain').setTargetAtTime(0.8, now, 0.02);
}

// ─── Resume (called synchronously in user gesture) ──────────────────────────

export function resumeAudioContext() {
  if (!audioCtx) return;
  // On mobile, resume() must be called directly in a user gesture handler.
  // It returns a promise, but the synchronous call itself is what unlocks audio.
  if (audioCtx.state === 'suspended') audioCtx.resume();

  // iOS silent mode workaround: play a silent buffer on each gesture
  try {
    const buf = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch {}
}

// ─── Eager init (called on page load, context starts suspended) ─────────────

export async function initAudioEagerly() {
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AC();
  // Context is suspended — that's fine, first user gesture will resume it.

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  freqData = new Uint8Array(analyser.frequencyBinCount);
  smoothedSpectrum = new Float32Array(analyser.frequencyBinCount);

  fadeGain = audioCtx.createGain();
  fadeGain.gain.value = 0;
  analyser.connect(fadeGain);
  fadeGain.connect(audioCtx.destination);

  let useWorklet = false;
  try {
    if (!audioCtx.audioWorklet) throw new Error('AudioWorklet not available');
    await audioCtx.audioWorklet.addModule('noise-processor.js');
    workletNode = new AudioWorkletNode(audioCtx, 'noise-processor', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    workletNode.connect(analyser);
    useWorklet = true;
    console.log('[noise] AudioWorklet initialized');
  } catch (err) {
    console.warn('[noise] AudioWorklet failed, using ScriptProcessor:', err.message);
    initScriptProcessorFallback();
  }

  audioReady = true;
  syncAudioParams();
  setupMediaSession();

  const method = useWorklet ? 'worklet' : 'scriptproc';
  document.getElementById('version').textContent =
    `${VERSION} · ${method} · ${audioCtx.sampleRate}Hz`;
}

// ─── ScriptProcessorNode fallback ────────────────────────────────────────────

function initScriptProcessorFallback() {
  const BUFFER_SIZE = 2048;
  scriptNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 2);

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
        buf[i] = cs.lpState * 0.8;
      }
    }

    const cross = 0.05, direct = 0.95;
    for (let i = 0; i < len; i++) {
      const l = L[i], r = R[i];
      L[i] = l * direct + r * cross;
      R[i] = r * direct + l * cross;
    }
  };

  // Silent looping source — some browsers need input for onaudioprocess to fire
  const silentBuf = audioCtx.createBuffer(1, BUFFER_SIZE, audioCtx.sampleRate);
  const silentSrc = audioCtx.createBufferSource();
  silentSrc.buffer = silentBuf;
  silentSrc.loop = true;
  silentSrc.connect(scriptNode);
  silentSrc.start(0);

  scriptNode.connect(analyser);
}
