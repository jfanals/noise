import { STATE_KEY, MAX_TRAIL } from './constants.js';

// ─── App state (mutable singleton) ──────────────────────────────────────────

export const state = {
  ballX: 0.5,
  ballY: 0.5,
  playing: false,
  timerSeconds: 0,
  audioInitialized: false,
};

export let trailDots = [];

// ─── Persistence (localStorage) ─────────────────────────────────────────────

export function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      ballX: state.ballX, ballY: state.ballY,
      timerSeconds: state.timerSeconds, trail: trailDots,
    }));
  } catch {}
}

export function loadState() {
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

export function pushTrailDot() {
  const last = trailDots[trailDots.length - 1];
  if (last && Math.abs(last.x - state.ballX) < 0.01 && Math.abs(last.y - state.ballY) < 0.01) return;
  trailDots.push({ x: state.ballX, y: state.ballY });
  if (trailDots.length > MAX_TRAIL) trailDots.shift();
}
