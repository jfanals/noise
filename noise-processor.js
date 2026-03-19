/**
 * NoiseProcessor — AudioWorklet for generating blended noise colors.
 *
 * Noise types mapped to noiseType parameter (0–1):
 *   0.00 = Brown  (-6 dB/oct, leaky integrator)
 *   0.25 = Pink   (-3 dB/oct, Voss-McCartney)
 *   0.50 = White  (flat spectrum)
 *   0.75 = Blue   (+3 dB/oct, first-order difference)
 *   1.00 = Violet (+6 dB/oct, second-order difference)
 *
 * Between anchor points, output crossfades linearly between the two
 * adjacent noise types. Only the two active types are generated per sample.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const NUM_PINK_STAGES = 7;

// Brown noise tuning
const BROWN_DECAY = 0.998;
const BROWN_INPUT_SCALE = 0.05;
const BROWN_OUTPUT_SCALE = 3.5;

// Blue/violet output scaling (for comparable loudness across types)
const BLUE_OUTPUT_SCALE = 0.7;
const VIOLET_OUTPUT_SCALE = 0.5;

// Stereo decorrelation amount (0 = independent, 1 = mono)
const STEREO_DECORRELATION = 0.05;

// ─── Processor ───────────────────────────────────────────────────────────────

class NoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain',       defaultValue: 0.5,   minValue: 0,  maxValue: 1 },
      { name: 'noiseType',  defaultValue: 0.5,   minValue: 0,  maxValue: 1 },
      { name: 'filterFreq', defaultValue: 20000, minValue: 20, maxValue: 20000 },
    ];
  }

  constructor() {
    super();
    this.channels = [];    // Per-channel filter/generator state
    this.hasSpare = false; // Box-Muller spare value ready
    this.spare = 0;
  }

  // ─── Gaussian random (Box-Muller polar form) ────────────────────────────

  gaussian() {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    let u, v, s;
    do {
      u = Math.random() * 2 - 1;
      v = Math.random() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt(-2 * Math.log(s) / s);
    this.spare = v * mul;
    this.hasSpare = true;
    return u * mul;
  }

  // ─── Per-channel state ──────────────────────────────────────────────────

  ensureChannel(ch) {
    if (!this.channels[ch]) {
      this.channels[ch] = {
        // Brown: leaky integrator accumulator
        brown: 0,
        // Pink: Voss-McCartney running sums
        pinkRows: new Float64Array(NUM_PINK_STAGES),
        pinkRunningSum: 0,
        pinkIndex: 0,
        // Blue: previous white sample for first-order difference
        bluePrev: 0,
        // Violet: two previous samples for second-order difference
        violetPrev1: 0,
        violetPrev2: 0,
        // One-pole low-pass filter state
        lpState: 0,
      };
    }
    return this.channels[ch];
  }

  // ─── Noise generators (each returns one sample, updates state) ──────────

  genBrown(channelState) {
    const white = this.gaussian();
    channelState.brown = channelState.brown * BROWN_DECAY + white * BROWN_INPUT_SCALE;
    return channelState.brown * BROWN_OUTPUT_SCALE;
  }

  genPink(channelState) {
    // Voss-McCartney: update one row per sample based on trailing zeros of counter
    const idx = channelState.pinkIndex;
    channelState.pinkIndex++;

    let numZeros = 0;
    if (idx !== 0) {
      let n = idx;
      while ((n & 1) === 0) { numZeros++; n >>= 1; }
    }

    if (numZeros < NUM_PINK_STAGES) {
      channelState.pinkRunningSum -= channelState.pinkRows[numZeros];
      const newRand = this.gaussian();
      channelState.pinkRows[numZeros] = newRand;
      channelState.pinkRunningSum += newRand;
    }

    // Add white noise for high-frequency component, normalize by √(stages + 1)
    const white = this.gaussian();
    return (channelState.pinkRunningSum + white) / Math.sqrt(NUM_PINK_STAGES + 1);
  }

  genWhite() {
    return this.gaussian();
  }

  genBlue(channelState) {
    // First-order difference of white noise → +3 dB/oct
    const white = this.gaussian();
    const out = white - channelState.bluePrev;
    channelState.bluePrev = white;
    return out * BLUE_OUTPUT_SCALE;
  }

  genViolet(channelState) {
    // Second-order difference of white noise → +6 dB/oct
    const white = this.gaussian();
    const out = white - 2 * channelState.violetPrev1 + channelState.violetPrev2;
    channelState.violetPrev2 = channelState.violetPrev1;
    channelState.violetPrev1 = white;
    return out * VIOLET_OUTPUT_SCALE;
  }

  // ─── Blended noise output ──────────────────────────────────────────────

  // The 5 generators stored in order so we can index by segment
  generateForIndex(index, channelState) {
    switch (index) {
      case 0: return this.genBrown(channelState);
      case 1: return this.genPink(channelState);
      case 2: return this.genWhite();
      case 3: return this.genBlue(channelState);
      case 4: return this.genViolet(channelState);
    }
    return 0;
  }

  genNoise(channelState, noiseType) {
    // Map 0–1 to segments between the 5 noise anchors
    const scaled = noiseType * 4;
    const seg = Math.min(Math.floor(scaled), 3);
    const blend = scaled - seg;

    // Only generate the two types we're blending between
    const a = this.generateForIndex(seg, channelState);
    const b = this.generateForIndex(seg + 1, channelState);
    return a * (1 - blend) + b * blend;
  }

  // ─── Main process loop ─────────────────────────────────────────────────

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const numChannels = output.length;
    const blockSize = output[0].length;

    // Read parameters — check if constant (k-rate) or per-sample (a-rate)
    const gainParam = parameters.gain;
    const typeParam = parameters.noiseType;
    const freqParam = parameters.filterFreq;
    const gainIsConst = gainParam.length === 1;
    const typeIsConst = typeParam.length === 1;
    const freqIsConst = freqParam.length === 1;

    // Pre-compute filter coefficient if frequency is constant across block
    let constAlpha;
    if (freqIsConst) {
      const omega = 2 * Math.PI * freqParam[0] / sampleRate;
      constAlpha = omega / (omega + 1); // one-pole LPF coefficient
    }

    for (let ch = 0; ch < numChannels; ch++) {
      const channelState = this.ensureChannel(ch);
      const buf = output[ch];

      for (let i = 0; i < blockSize; i++) {
        const gain = gainIsConst ? gainParam[0] : gainParam[i];
        const noiseType = typeIsConst ? typeParam[0] : typeParam[i];

        // Generate blended noise and soft-clip via tanh
        let sample = Math.tanh(this.genNoise(channelState, noiseType));

        // One-pole low-pass filter: y[n] = y[n-1] + α·(x[n] - y[n-1])
        let alpha = constAlpha;
        if (!freqIsConst) {
          const omega = 2 * Math.PI * freqParam[i] / sampleRate;
          alpha = omega / (omega + 1);
        }
        channelState.lpState += alpha * (sample - channelState.lpState);

        buf[i] = channelState.lpState * gain;
      }
    }

    // Stereo decorrelation: cross-mix a small fraction between L and R
    if (numChannels === 2) {
      const L = output[0];
      const R = output[1];
      const cross = STEREO_DECORRELATION;
      const direct = 1 - cross;
      for (let i = 0; i < blockSize; i++) {
        const l = L[i];
        const r = R[i];
        L[i] = l * direct + r * cross;
        R[i] = r * direct + l * cross;
      }
    }

    return true;
  }
}

registerProcessor('noise-processor', NoiseProcessor);
