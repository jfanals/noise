// All drawing functions: spectrum, grid, crosshair, dots.

import { NOISE_TYPES } from './constants.js';
import { normToFreq, freqToNorm, colorForPosition, rgbString, dotRadius, labelFont } from './helpers.js';
import { state, trailDots } from './state.js';
import { audioCtx, analyser, freqData, smoothedSpectrum } from './audio.js';
import { getCtx, logicalSize, ballToPixel } from './canvas.js';

// ─── Spectrum analyzer ──────────────────────────────────────────────────────

export function drawSpectrum(alpha) {
  if (!analyser || !state.playing || alpha <= 0.001) return;
  const ctx = getCtx();
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

// ─── Grid and labels ────────────────────────────────────────────────────────

export function drawGrid(alpha) {
  if (alpha <= 0.001) return;
  const ctx = getCtx();
  const { w, h } = logicalSize();
  const fontSize = labelFont();
  const padTop = fontSize + 8;
  const padBottom = fontSize + 12;

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
  for (const { pos, name } of NOISE_TYPES) {
    const rawY = h - pos * h - 6;
    const y = Math.max(padTop, Math.min(h - padBottom, rawY));
    ctx.fillText(name, 10, y);
  }

  const freqFontSize = Math.round(fontSize * 0.8);
  ctx.font = `${freqFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  for (const [freq, label] of [[100, '100Hz'], [1000, '1kHz'], [10000, '10kHz']])
    ctx.fillText(label, freqToNorm(freq) * w, h - 10);

  ctx.restore();
}

// ─── Crosshair ──────────────────────────────────────────────────────────────

export function drawCrosshair(alpha) {
  if (alpha <= 0.001) return;
  const ctx = getCtx();
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

// ─── Dots (active + trail) ──────────────────────────────────────────────────

function drawDot(x, y, alpha, radius) {
  const ctx = getCtx();
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

export function drawTrailDots(alpha) {
  if (alpha <= 0.001) return;
  const radius = dotRadius();
  for (let i = 0; i < trailDots.length; i++) {
    const dot = trailDots[i];
    const ageRatio = (i + 1) / (trailDots.length + 1);
    drawDot(dot.x, dot.y, ageRatio * 0.35 * alpha, radius * (0.6 + ageRatio * 0.4));
  }
}

export function drawActiveDot(dragging) {
  const radius = dotRadius();
  const alpha = dragging ? 1.0 : 0.7;
  const r = dragging ? radius + 4 : radius;
  drawDot(state.ballX, state.ballY, alpha, r);
}
