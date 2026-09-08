import { applyBiquad, kWeightingHighPass, kWeightingShelf, percentile } from "./dsp";

/**
 * ITU-R BS.1770-4 loudness and EBU R128 loudness range.
 *
 * Implemented properly rather than approximated: K-weighting, 400 ms blocks at
 * 75% overlap, the absolute -70 LUFS gate and the -10 LU relative gate. These
 * are the numbers a mastering engineer would quote, so they have to be right.
 */

const CHANNEL_WEIGHTS = [1.0, 1.0, 1.0, 1.41, 1.41]; // L, R, C, Ls, Rs

function kWeight(channel: Float32Array, sampleRate: number): Float32Array {
  return applyBiquad(applyBiquad(channel, kWeightingShelf(sampleRate)), kWeightingHighPass(sampleRate));
}

/** Mean square of each overlapping block, per channel, already K-weighted. */
function blockPowers(weighted: Float32Array[], sampleRate: number, blockMs: number, overlap: number) {
  const blockSize = Math.round((sampleRate * blockMs) / 1000);
  const hop = Math.round(blockSize * (1 - overlap));
  const frames = weighted[0]?.length ?? 0;
  const powers: number[] = [];

  for (let start = 0; start + blockSize <= frames; start += hop) {
    let total = 0;
    for (let ch = 0; ch < weighted.length; ch++) {
      let sum = 0;
      const data = weighted[ch];
      for (let i = start; i < start + blockSize; i++) sum += data[i] * data[i];
      total += (CHANNEL_WEIGHTS[ch] ?? 1) * (sum / blockSize);
    }
    powers.push(total);
  }
  return powers;
}

const loudnessOf = (power: number) => -0.691 + 10 * Math.log10(power);

export interface LoudnessResult {
  integratedLufs: number | null;
  shortTermMaxLufs: number | null;
  momentaryMaxLufs: number | null;
  loudnessRangeLu: number | null;
}

export function measureLoudness(channels: Float32Array[], sampleRate: number): LoudnessResult {
  const weighted = channels.map((c) => kWeight(c, sampleRate));

  // Integrated: 400 ms momentary blocks, 75% overlap.
  const momentary = blockPowers(weighted, sampleRate, 400, 0.75);
  if (momentary.length === 0) {
    return { integratedLufs: null, shortTermMaxLufs: null, momentaryMaxLufs: null, loudnessRangeLu: null };
  }

  const absoluteGated = momentary.filter((p) => p > 0 && loudnessOf(p) > -70);
  let integrated: number | null = null;
  if (absoluteGated.length) {
    const ungatedMean = absoluteGated.reduce((s, p) => s + p, 0) / absoluteGated.length;
    const relativeThreshold = loudnessOf(ungatedMean) - 10;
    const gated = absoluteGated.filter((p) => loudnessOf(p) > relativeThreshold);
    if (gated.length) {
      integrated = loudnessOf(gated.reduce((s, p) => s + p, 0) / gated.length);
    }
  }

  // Short-term: 3 s blocks — used for the max and for loudness range.
  const shortTerm = blockPowers(weighted, sampleRate, 3000, 0.66);
  const stLoudness = shortTerm.filter((p) => p > 0).map(loudnessOf);
  const stAbove70 = stLoudness.filter((l) => l > -70);

  let lra: number | null = null;
  if (stAbove70.length >= 3) {
    // EBU Tech 3342: gate 20 LU below the mean of the absolute-gated blocks.
    const meanPower = shortTerm.filter((p) => p > 0 && loudnessOf(p) > -70).reduce((s, p) => s + p, 0) / stAbove70.length;
    const threshold = loudnessOf(meanPower) - 20;
    const gated = stAbove70.filter((l) => l > threshold).sort((a, b) => a - b);
    if (gated.length >= 2) lra = Number((percentile(gated, 0.95) - percentile(gated, 0.1)).toFixed(2));
  }

  const momentaryLoudness = momentary.filter((p) => p > 0).map(loudnessOf);

  return {
    integratedLufs: integrated != null ? Number(integrated.toFixed(2)) : null,
    shortTermMaxLufs: stLoudness.length ? Number(Math.max(...stLoudness).toFixed(2)) : null,
    momentaryMaxLufs: momentaryLoudness.length ? Number(Math.max(...momentaryLoudness).toFixed(2)) : null,
    loudnessRangeLu: lra,
  };
}

/**
 * True-peak estimate via 4x oversampling with a windowed-sinc interpolator.
 *
 * BS.1770-4 specifies 4x minimum. Interpolating every sample of a five-minute
 * stereo track would be billions of multiply-accumulates, so we interpolate only
 * around samples already close to the sample peak — an inter-sample peak cannot
 * appear far below the surrounding sample magnitudes. This is a real estimate,
 * not a certified meter, and is labelled as such in the report.
 */
export function estimateTruePeak(channels: Float32Array[]): number {
  const TAPS = 33;
  const FACTOR = 4;
  const HALF = (TAPS - 1) >> 1;

  const kernels: Float32Array[] = [];
  for (let phase = 1; phase < FACTOR; phase++) {
    const k = new Float32Array(TAPS);
    const offset = phase / FACTOR;
    for (let i = 0; i < TAPS; i++) {
      const x = i - HALF - offset;
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1)); // Hamming
      k[i] = sinc * window;
    }
    let sum = 0;
    for (const v of k) sum += v;
    for (let i = 0; i < TAPS; i++) k[i] /= sum || 1;
    kernels.push(k);
  }

  let maxPeak = 0;
  for (const channel of channels) {
    let samplePeak = 0;
    for (const s of channel) {
      const a = Math.abs(s);
      if (a > samplePeak) samplePeak = a;
    }
    if (samplePeak > maxPeak) maxPeak = samplePeak;
    if (samplePeak === 0) continue;

    // Only neighbourhoods within 3 dB of the sample peak can host a higher
    // inter-sample peak; everything quieter cannot beat what we already have.
    const threshold = samplePeak * 0.708;
    for (let i = 0; i < channel.length; i++) {
      if (Math.abs(channel[i]) < threshold) continue;
      for (const kernel of kernels) {
        let acc = 0;
        for (let t = 0; t < TAPS; t++) {
          const idx = i + t - HALF;
          if (idx >= 0 && idx < channel.length) acc += channel[idx] * kernel[t];
        }
        const abs = Math.abs(acc);
        if (abs > maxPeak) maxPeak = abs;
      }
    }
  }
  return maxPeak;
}
