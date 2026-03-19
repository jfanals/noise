# Noise

Ultra-minimal browser-based noise generator. A black screen, a colored dot, and your ears.

**[→ Try it live](https://jfanals.github.io/noise/)**

## What it does

Drag the dot across the screen to explore a 2D spectrum of noise:

- **Y-axis** — noise color: Brown → Pink → White → Blue → Violet
- **X-axis** — filter cutoff frequency: 20 Hz → 20 kHz (logarithmic)

The dot takes on the color of the noise type at its position. While dragging, a real-time spectrum analyzer, grid overlay, and info HUD fade in. Release and everything disappears — just the dot on black.

## Features

- **5 noise types** with smooth crossfading between them
- **Live spectrum analyzer** showing the frequency shape of whatever you're hearing
- **Trail dots** — up to 10 past positions shown while dragging, like bookmarks
- **Listening timer** — tracks how long you've been listening (double-tap to reset)
- **Mobile play/pause** — integrates with MediaSession API for lock-screen controls
- **State persistence** — remembers your position, trail, and timer across sessions
- **500ms audio fade** — smooth fade-in on start, fade-out on pause
- **Perceptually smooth noise** — Gaussian distribution + soft clipping, no harsh spikes
- **Zero dependencies** — vanilla JS, no build step, ~930 lines total

## Noise types

| Type | Spectrum | Sound |
|------|----------|-------|
| **Brown** | −6 dB/octave | Deep rumble, like heavy wind |
| **Pink** | −3 dB/octave | Balanced, like rain |
| **White** | Flat | Bright hiss, like static |
| **Blue** | +3 dB/octave | Airy hiss, like a spray |
| **Violet** | +6 dB/octave | Sharp sizzle |

## Technical details

- **Audio**: Web Audio API with AudioWorklet running on a dedicated thread
- **Noise generation**: Voss-McCartney (pink), leaky integrator (brown), first/second-order differencing (blue/violet), Box-Muller Gaussian distribution
- **Only 2 noise types generated per sample** — the two being blended, not all 5
- **Spectrum**: AnalyserNode FFT with logarithmic frequency binning
- **Rendering**: Canvas 2D with DPR-aware sizing

## Run locally

```
npx serve .
```

Or any static file server — no build step needed.

## Deploy

Hosted on GitHub Pages from the `main` branch root.

## License

MIT
