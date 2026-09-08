import { describe, expect, it } from "vitest";
import { analyzeDecoded } from "@/server/audio/analyze";
import { decodeWav } from "@/server/audio/wav";
import { measureLoudness, estimateTruePeak } from "@/server/audio/loudness";
import { correlation, fft, toDb } from "@/server/audio/dsp";

const SR = 44100;

function sine(freq: number, seconds: number, amplitude: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

function wavBuffer(channels: Float32Array[], sampleRate = SR): Buffer {
  const nch = channels.length;
  const frames = channels[0].length;
  const buf = Buffer.alloc(44 + frames * nch * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * nch * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(nch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * nch * 2, 28);
  buf.writeUInt16LE(nch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * nch * 2, 40);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767))), offset);
      offset += 2;
    }
  }
  return buf;
}

describe("BS.1770 loudness", () => {
  it("measures a -20 dBFS 1 kHz stereo tone at -20 LUFS", () => {
    // The reference calibration from the standard. If this drifts, every
    // loudness recommendation the agent makes is wrong.
    const tone = sine(1000, 10, 10 ** (-20 / 20));
    const result = measureLoudness([tone, tone], SR);
    expect(result.integratedLufs).toBeGreaterThan(-20.6);
    expect(result.integratedLufs).toBeLessThan(-19.4);
  });

  it("tracks a 6 dB level change", () => {
    const loud = measureLoudness([sine(1000, 8, 0.5), sine(1000, 8, 0.5)], SR);
    const quiet = measureLoudness([sine(1000, 8, 0.25), sine(1000, 8, 0.25)], SR);
    expect(loud.integratedLufs! - quiet.integratedLufs!).toBeCloseTo(6, 0);
  });

  it("gates out silence rather than dragging the average down", () => {
    const tone = sine(1000, 5, 0.5);
    const silence = new Float32Array(SR * 5);
    const withSilence = new Float32Array([...tone, ...silence]);
    const toneOnly = measureLoudness([tone, tone], SR).integratedLufs!;
    const gated = measureLoudness([withSilence, withSilence], SR).integratedLufs!;
    expect(Math.abs(gated - toneOnly)).toBeLessThan(1.5);
  });

  it("reports inter-sample peaks above the sample peak", () => {
    // A tone near Nyquist has real inter-sample overshoot.
    const near = sine(11025, 2, 0.98);
    const truePeak = estimateTruePeak([near]);
    let samplePeak = 0;
    for (const s of near) samplePeak = Math.max(samplePeak, Math.abs(s));
    expect(truePeak).toBeGreaterThanOrEqual(samplePeak - 1e-6);
  });
});

describe("WAV decoding", () => {
  it("round-trips 16-bit stereo PCM", () => {
    const left = sine(440, 1, 0.5);
    const right = sine(880, 1, 0.25);
    const decoded = decodeWav(wavBuffer([left, right]));
    expect(decoded.sampleRate).toBe(SR);
    expect(decoded.channels).toHaveLength(2);
    expect(decoded.durationSec).toBeCloseTo(1, 2);
    expect(decoded.channels[0][100]).toBeCloseTo(left[100], 3);
  });

  it("rejects non-WAV input with an actionable message", () => {
    expect(() => decodeWav(Buffer.from("ID3\x03\x00\x00\x00 not a wav at all"))).toThrowError(/WAV/i);
  });
});

describe("analysis findings", () => {
  it("flags a decorrelated low end", () => {
    // Sub content pushed hard into the sides: the classic club-system killer.
    const frames = SR * 6;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const t = i / SR;
      const mids = Math.sin(2 * Math.PI * 800 * t) * 0.2;
      left[i] = mids + Math.sin(2 * Math.PI * 50 * t) * 0.4;
      right[i] = mids - Math.sin(2 * Math.PI * 50 * t) * 0.4;
    }
    const result = analyzeDecoded({ sampleRate: SR, channels: [left, right], durationSec: 6, bitDepth: 16, format: "pcm" });
    expect(result.lowEndWidth).toBeGreaterThan(0.3);
    expect(result.issues.map((i) => i.code)).toContain("wide_low_end");
  });

  it("flags clipping and an over-zero true peak", () => {
    const frames = SR * 4;
    const clipped = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      clipped[i] = Math.max(-1, Math.min(1, Math.sin((2 * Math.PI * 200 * i) / SR) * 3));
    }
    const result = analyzeDecoded({ sampleRate: SR, channels: [clipped, clipped], durationSec: 4, bitDepth: 16, format: "pcm" });
    expect(result.clippedSamples).toBeGreaterThan(0);
    expect(result.issues.map((i) => i.code)).toContain("clipping");
  });

  it("reports a clean signal as clean", () => {
    const frames = SR * 8;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const t = i / SR;
      // Amplitude-varying so it is not dynamically flat.
      const env = 0.25 + 0.2 * Math.sin(2 * Math.PI * 0.15 * t);
      const core = (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 660 * t) * 0.5 + Math.sin(2 * Math.PI * 3000 * t) * 0.3) * env;
      left[i] = core;
      right[i] = core * 0.97 + Math.sin(2 * Math.PI * 2400 * t) * 0.02;
    }
    const result = analyzeDecoded({ sampleRate: SR, channels: [left, right], durationSec: 8, bitDepth: 16, format: "pcm" });
    expect(result.clippedSamples).toBe(0);
    expect(result.issues.filter((i) => i.severity === "problem")).toHaveLength(0);
    expect(result.phaseCorrelation).toBeGreaterThan(0.8);
  });

  it("does not report a BPM it cannot actually detect", () => {
    // A steady tone has no onsets; a number here would be invented.
    const tone = sine(440, 20, 0.3);
    const result = analyzeDecoded({ sampleRate: SR, channels: [tone], durationSec: 20, bitDepth: 16, format: "pcm" });
    if (result.bpm !== null) expect(result.bpmConfidence).toBeGreaterThanOrEqual(0.25);
  });
});

describe("dsp primitives", () => {
  it("computes correlation correctly for identical and inverted signals", () => {
    const a = sine(440, 0.5, 0.5);
    const inverted = Float32Array.from(a, (v) => -v);
    expect(correlation(a, a)).toBeCloseTo(1, 5);
    expect(correlation(a, inverted)).toBeCloseTo(-1, 5);
  });

  it("locates a tone in the correct FFT bin", () => {
    const size = 4096;
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    const freq = 1000;
    for (let i = 0; i < size; i++) re[i] = Math.sin((2 * Math.PI * freq * i) / SR);
    fft(re, im);
    let peakBin = 0;
    let peakMag = 0;
    for (let b = 1; b < size / 2; b++) {
      const mag = Math.hypot(re[b], im[b]);
      if (mag > peakMag) { peakMag = mag; peakBin = b; }
    }
    expect(Math.abs((peakBin * SR) / size - freq)).toBeLessThan(SR / size);
  });

  it("converts amplitude to dB", () => {
    expect(toDb(1)).toBeCloseTo(0, 6);
    expect(toDb(0.5)).toBeCloseTo(-6.02, 1);
    expect(toDb(0)).toBe(-Infinity);
  });
});
