import { NOISE_TYPES, BASE_DOT_RADIUS, BASE_LABEL_FONT } from './constants.js';

// ─── Responsive sizing ───────────────────────────────────────────────────────

export function isTouchDevice() {
  return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
}

export function uiScale() { return isTouchDevice() ? 3 : 1; }
export function dotRadius()  { return BASE_DOT_RADIUS * uiScale(); }
export function labelFont()  { return BASE_LABEL_FONT * uiScale(); }

// ─── Math / formatting ──────────────────────────────────────────────────────

export function normToFreq(x) { return 20 * Math.pow(1000, x); }
export function freqToNorm(freq) { return Math.log(freq / 20) / Math.log(1000); }

export function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

export function formatFreq(x) {
  const freq = normToFreq(x);
  return freq >= 1000 ? `${(freq / 1000).toFixed(1)}kHz` : `${Math.round(freq)}Hz`;
}

export function findSegment(value, stops) {
  for (let i = 0; i < stops.length - 1; i++) {
    if (value <= stops[i + 1].pos) {
      const lower = stops[i], upper = stops[i + 1];
      return { lower, upper, t: (value - lower.pos) / (upper.pos - lower.pos) };
    }
  }
  return { lower: stops[stops.length - 2], upper: stops[stops.length - 1], t: 1 };
}

export function rgbString(r, g, b, a = 1) { return `rgba(${r}, ${g}, ${b}, ${a})`; }

// ─── Noise color helpers ─────────────────────────────────────────────────────

export function colorForPosition(x, y) {
  const { lower, upper, t } = findSegment(y, NOISE_TYPES);
  const brightness = 0.5 + x * 0.5;
  return {
    r: Math.round((lower.r + (upper.r - lower.r) * t) * brightness),
    g: Math.round((lower.g + (upper.g - lower.g) * t) * brightness),
    b: Math.round((lower.b + (upper.b - lower.b) * t) * brightness),
  };
}

export function noiseTypeName(y) {
  const { lower, upper, t } = findSegment(y, NOISE_TYPES);
  if (t < 0.15) return lower.name;
  if (t > 0.85) return upper.name;
  return `${lower.name}–${upper.name}`;
}
