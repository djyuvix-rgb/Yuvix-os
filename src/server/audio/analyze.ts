import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { decodeWav, UnsupportedAudioError, type DecodedAudio } from "./wav";
import { applyBiquad, correlation, fft, hann, lowPass, peak, rms, toDb } from "./dsp";
import { estimateTruePeak, measureLoudness } from "./loudness";

export interface AudioIssue {
  severity: "info" | "warning" | "problem";
  code: string;
  message: string;
  suggestion: string;
}

export interface SpectrumBand {
  band: string;
  hz: number;
  db: number;
}

export interface AudioAnalysisResult {
  format: string;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  durationSec: number;
  bpm: number | null;
  bpmConfidence: number | null;
  musicalKey: string | null;
  camelot: string | null;
  keyConfidence: number | null;
  lufsIntegrated: number | null;
  lufsShortTermMax: number | null;
  loudnessRangeLu: number | null;
  truePeakDb: number | null;
  samplePeakDb: number;
  crestFactorDb: number;
  dynamicRangeDb: number | null;
  stereoWidth: number | null;
  phaseCorrelation: number | null;
  monoCompatibilityDb: number | null;
  lowEndWidth: number | null;
  clippedSamples: number;
  spectrum: SpectrumBand[];
  issues: AudioIssue[];
  summary: string;
  fileHash: string;
}

const OCTAVE_BANDS: [string, number, number][] = [
  ["sub", 20, 60],
  ["low bass", 60, 120],
  ["upper bass", 120, 250],
  ["low mids", 250, 500],
  ["mids", 500, 2000],
  ["upper mids", 2000, 4000],
  ["presence", 4000, 8000],
  ["air", 8000, 16000],
];

/** Krumhansl-Kessler key profiles — the standard correlation approach. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** Camelot wheel: index = pitch class, [minor, major]. */
const CAMELOT: [string, string][] = [
  ["5A", "8B"], ["12A", "3B"], ["7A", "10B"], ["2A", "5B"], ["9A", "12B"], ["4A", "7B"],
  ["11A", "2B"], ["6A", "9B"], ["1A", "4B"], ["8A", "11B"], ["3A", "6B"], ["10A", "1B"],
];

export async function analyzeAudioFile(path: string): Promise<AudioAnalysisResult> {
  const ext = extname(path).toLowerCase();
  const info = await stat(path);
  if (info.size > 400 * 1024 * 1024) throw new UnsupportedAudioError("File is larger than 400 MB.");

  const buffer = await readFile(path);
  const fileHash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);

  if (![".wav", ".wave"].includes(ext)) {
    throw new UnsupportedAudioError(
      `Cannot analyse ${ext || "this file"} directly. The analyser reads uncompressed WAV. ` +
        "Bounce a WAV of the master (any sample rate, 16/24/32-bit) and analyse that — it is also what you would send to a label.",
    );
  }

  const audio = decodeWav(buffer);
  return analyzeDecoded(audio, fileHash);
}

export function analyzeDecoded(audio: DecodedAudio, fileHash = ""): AudioAnalysisResult {
  const { sampleRate, channels, durationSec } = audio;
  const mono = toMono(channels);

  const loudness = measureLoudness(channels, sampleRate);
  const samplePeak = Math.max(...channels.map(peak));
  const truePeak = estimateTruePeak(channels);
  const overallRms = rms(mono);
  const crestFactorDb = Number((toDb(samplePeak) - toDb(overallRms)).toFixed(2));

  // Stereo geometry
  let stereoWidth: number | null = null;
  let phaseCorrelation: number | null = null;
  let monoCompatibilityDb: number | null = null;
  let lowEndWidth: number | null = null;

  if (channels.length >= 2) {
    const [left, right] = channels;
    const mid = new Float32Array(left.length);
    const side = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      mid[i] = (left[i] + right[i]) / 2;
      side[i] = (left[i] - right[i]) / 2;
    }
    const midRms = rms(mid);
    const sideRms = rms(side);
    stereoWidth = midRms > 0 ? Number(Math.min(sideRms / midRms, 4).toFixed(3)) : null;
    phaseCorrelation = Number(correlation(left, right).toFixed(3));
    // What the club's mono sub, or a phone speaker, actually loses.
    monoCompatibilityDb = Number((toDb(midRms) - toDb(rms(interleaveRms(left, right)))).toFixed(2));

    const lp = lowPass(sampleRate, 120);
    const lowMid = applyBiquad(mid, lp);
    const lowSide = applyBiquad(side, lp);
    const lowMidRms = rms(lowMid);
    lowEndWidth = lowMidRms > 0 ? Number(Math.min(rms(lowSide) / lowMidRms, 4).toFixed(3)) : null;
  }

  const spectrum = computeSpectrum(mono, sampleRate);
  const clippedSamples = countClipped(channels);
  const { bpm, confidence: bpmConfidence } = estimateBpm(mono, sampleRate);
  const key = estimateKey(mono, sampleRate);

  const issues = deriveIssues({
    loudness,
    truePeakDb: toDb(truePeak),
    samplePeakDb: toDb(samplePeak),
    crestFactorDb,
    stereoWidth,
    phaseCorrelation,
    lowEndWidth,
    monoCompatibilityDb,
    clippedSamples,
    spectrum,
    channels: channels.length,
    durationSec,
  });

  return {
    format: `WAV ${audio.format} ${audio.bitDepth}-bit`,
    sampleRate,
    channels: channels.length,
    bitDepth: audio.bitDepth,
    durationSec: Number(durationSec.toFixed(2)),
    bpm,
    bpmConfidence,
    musicalKey: key.name,
    camelot: key.camelot,
    keyConfidence: key.confidence,
    lufsIntegrated: loudness.integratedLufs,
    lufsShortTermMax: loudness.shortTermMaxLufs,
    loudnessRangeLu: loudness.loudnessRangeLu,
    truePeakDb: Number(toDb(truePeak).toFixed(2)),
    samplePeakDb: Number(toDb(samplePeak).toFixed(2)),
    crestFactorDb,
    dynamicRangeDb: loudness.loudnessRangeLu,
    stereoWidth,
    phaseCorrelation,
    monoCompatibilityDb,
    lowEndWidth,
    clippedSamples,
    spectrum,
    issues,
    summary: writeSummary({ loudness, issues, bpm, key, durationSec }),
    fileHash,
  };
}

function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/** RMS reference for the un-summed stereo signal, for mono-compatibility comparison. */
function interleaveRms(left: Float32Array, right: Float32Array): Float32Array {
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) out[i] = Math.sqrt((left[i] * left[i] + right[i] * right[i]) / 2);
  return out;
}

function countClipped(channels: Float32Array[]): number {
  let count = 0;
  for (const ch of channels) {
    let run = 0;
    for (const s of ch) {
      if (Math.abs(s) >= 0.9995) {
        run++;
        // Three consecutive full-scale samples is the usual clipping heuristic;
        // a single one can legitimately be a peak that lands exactly at 0 dBFS.
        if (run >= 3) count++;
      } else {
        run = 0;
      }
    }
  }
  return count;
}

function computeSpectrum(mono: Float32Array, sampleRate: number): SpectrumBand[] {
  const size = 4096;
  const window = hann(size);
  const bins = new Float64Array(size / 2);
  let frames = 0;

  // Average magnitude spectrum over frames spread across the whole track.
  const hop = Math.max(size, Math.floor((mono.length - size) / 200));
  for (let start = 0; start + size <= mono.length; start += hop) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = mono[start + i] * window[i];
    fft(re, im);
    for (let b = 0; b < size / 2; b++) bins[b] += Math.sqrt(re[b] * re[b] + im[b] * im[b]);
    frames++;
  }
  if (frames === 0) return [];

  const binHz = sampleRate / size;
  return OCTAVE_BANDS.map(([band, lo, hi]) => {
    let energy = 0;
    let count = 0;
    for (let b = 1; b < bins.length; b++) {
      const hz = b * binHz;
      if (hz >= lo && hz < hi) {
        const mag = bins[b] / frames;
        energy += mag * mag;
        count++;
      }
    }
    const level = count ? Math.sqrt(energy / count) : 0;
    return { band, hz: Math.round((lo + hi) / 2), db: Number(toDb(level || 1e-9).toFixed(1)) };
  });
}

/**
 * BPM via spectral-flux onset detection and autocorrelation over the 70–190 BPM
 * range typical of club music. Returns a confidence so the caller can decide
 * whether to trust it rather than presenting a guess as a measurement.
 */
function estimateBpm(mono: Float32Array, sampleRate: number): { bpm: number | null; confidence: number | null } {
  const size = 1024;
  const hop = 512;
  if (mono.length < sampleRate * 10) return { bpm: null, confidence: null };

  const window = hann(size);
  const flux: number[] = [];
  let prev = new Float64Array(size / 2);

  for (let start = 0; start + size <= mono.length; start += hop) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = mono[start + i] * window[i];
    fft(re, im);
    const mag = new Float64Array(size / 2);
    let sum = 0;
    for (let b = 0; b < size / 2; b++) {
      mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      const diff = mag[b] - prev[b];
      if (diff > 0) sum += diff; // half-wave rectified: onsets only
    }
    flux.push(sum);
    prev = mag;
  }
  if (flux.length < 64) return { bpm: null, confidence: null };

  const mean = flux.reduce((s, v) => s + v, 0) / flux.length;
  const centred = flux.map((v) => v - mean);

  const frameRate = sampleRate / hop;
  const minLag = Math.floor((60 / 190) * frameRate);
  const maxLag = Math.ceil((60 / 70) * frameRate);

  let bestLag = 0;
  let bestScore = -Infinity;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag && lag < centred.length; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < centred.length; i++) sum += centred[i] * centred[i + lag];
    const score = sum / (centred.length - lag);
    scores.push(score);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return { bpm: null, confidence: null };

  // Lags are integers, which quantises BPM by ~1 at club tempos. Fit a parabola
  // through the peak and its neighbours to recover the sub-frame maximum.
  const idx = bestLag - minLag;
  let refinedLag = bestLag;
  if (idx > 0 && idx < scores.length - 1) {
    const [y0, y1, y2] = [scores[idx - 1], scores[idx], scores[idx + 1]];
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) refinedLag = bestLag + (0.5 * (y0 - y2)) / denom;
  }

  const bpm = (60 * frameRate) / refinedLag;
  const meanScore = scores.reduce((s, v) => s + v, 0) / scores.length;
  const std = Math.sqrt(scores.reduce((s, v) => s + (v - meanScore) ** 2, 0) / scores.length);
  const confidence = std > 0 ? Math.min(1, Math.max(0, (bestScore - meanScore) / (4 * std))) : 0;

  // Below this, the autocorrelation peak is not distinguishable from the noise
  // floor — reporting a number would be inventing one.
  if (confidence < 0.25) return { bpm: null, confidence: Number(confidence.toFixed(2)) };

  return { bpm: Number(bpm.toFixed(1)), confidence: Number(confidence.toFixed(2)) };
}

function estimateKey(mono: Float32Array, sampleRate: number): { name: string | null; camelot: string | null; confidence: number | null } {
  const size = 8192;
  if (mono.length < size * 4) return { name: null, camelot: null, confidence: null };

  const window = hann(size);
  const chroma = new Float64Array(12);
  const hop = Math.max(size, Math.floor((mono.length - size) / 120));
  const binHz = sampleRate / size;

  for (let start = 0; start + size <= mono.length; start += hop) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = mono[start + i] * window[i];
    fft(re, im);
    for (let b = 1; b < size / 2; b++) {
      const hz = b * binHz;
      if (hz < 55 || hz > 2000) continue; // A1..B6: where pitch information lives
      const midi = 69 + 12 * Math.log2(hz / 440);
      const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pitchClass] += Math.sqrt(re[b] * re[b] + im[b] * im[b]);
    }
  }

  const total = chroma.reduce((s, v) => s + v, 0);
  if (total === 0) return { name: null, camelot: null, confidence: null };
  const normalised = Array.from(chroma, (v) => v / total);

  const correlate = (profile: number[], rotation: number) => {
    const rotated = profile.map((_, i) => profile[(i - rotation + 12) % 12]);
    const meanA = normalised.reduce((s, v) => s + v, 0) / 12;
    const meanB = rotated.reduce((s, v) => s + v, 0) / 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) {
      const x = normalised[i] - meanA;
      const y = rotated[i] - meanB;
      num += x * y; da += x * x; db += y * y;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  };

  let best = { score: -Infinity, pitch: 0, minor: false };
  let second = -Infinity;
  for (let pitch = 0; pitch < 12; pitch++) {
    for (const minor of [false, true]) {
      const score = correlate(minor ? MINOR_PROFILE : MAJOR_PROFILE, pitch);
      if (score > best.score) {
        second = best.score;
        best = { score, pitch, minor };
      } else if (score > second) {
        second = score;
      }
    }
  }

  const margin = Number.isFinite(second) ? best.score - second : 0;
  return {
    name: `${NOTE_NAMES[best.pitch]} ${best.minor ? "minor" : "major"}`,
    camelot: CAMELOT[best.pitch][best.minor ? 0 : 1],
    confidence: Number(Math.min(1, Math.max(0, margin * 4)).toFixed(2)),
  };
}

/**
 * Turns measurements into findings. Thresholds reflect club/streaming practice:
 * streaming normalises to about -14 LUFS, club masters usually land -9 to -6,
 * and mono sub is close to universal in dance music.
 */
function deriveIssues(m: {
  loudness: ReturnType<typeof measureLoudness>;
  truePeakDb: number;
  samplePeakDb: number;
  crestFactorDb: number;
  stereoWidth: number | null;
  phaseCorrelation: number | null;
  lowEndWidth: number | null;
  monoCompatibilityDb: number | null;
  clippedSamples: number;
  spectrum: SpectrumBand[];
  channels: number;
  durationSec: number;
}): AudioIssue[] {
  const issues: AudioIssue[] = [];
  const lufs = m.loudness.integratedLufs;

  if (m.clippedSamples > 0) {
    issues.push({
      severity: m.clippedSamples > 200 ? "problem" : "warning",
      code: "clipping",
      message: `${m.clippedSamples} samples sit at full scale in runs of three or more — the master is clipping.`,
      suggestion: "Pull the master fader down 1–2 dB and let the limiter do less work, or fix the loudest element before the limiter.",
    });
  }

  if (m.truePeakDb > -0.1) {
    issues.push({
      severity: "problem",
      code: "true_peak_over",
      message: `Estimated true peak is ${m.truePeakDb.toFixed(2)} dBTP — above 0, so lossy encoders will distort it.`,
      suggestion: "Set the limiter ceiling to -1.0 dBTP for streaming, or -0.3 dBTP for a WAV going to a label.",
    });
  } else if (m.truePeakDb > -0.5) {
    issues.push({
      severity: "warning",
      code: "true_peak_tight",
      message: `True peak ${m.truePeakDb.toFixed(2)} dBTP leaves almost no headroom for MP3/AAC conversion.`,
      suggestion: "A -1.0 dBTP ceiling is the safe default for anything that will be streamed.",
    });
  }

  if (lufs != null) {
    if (lufs > -6) {
      issues.push({
        severity: "warning",
        code: "very_loud",
        message: `Integrated loudness is ${lufs} LUFS — very hot. Streaming platforms will turn it down about ${Math.abs(-14 - lufs).toFixed(1)} dB, so the loudness gained here is lost, and the squashing stays.`,
        suggestion: "Unless this is a club-only dub, back off the limiter and win on punch instead of level.",
      });
    } else if (lufs < -16) {
      issues.push({
        severity: "info",
        code: "quiet_master",
        message: `Integrated loudness is ${lufs} LUFS — quieter than typical club masters (-9 to -6) and below the streaming target (-14).`,
        suggestion: "Fine if intentional. In a DJ set next to commercial masters it will feel weak unless the DJ rides the gain.",
      });
    }
  }

  if (m.loudness.loudnessRangeLu != null && m.loudness.loudnessRangeLu < 3) {
    issues.push({
      severity: "warning",
      code: "low_dynamics",
      message: `Loudness range is ${m.loudness.loudnessRangeLu} LU — the track is dynamically flat from start to end.`,
      suggestion: "Check that breakdowns and drops actually differ in level. Flat dynamics make a track tiring on a big system.",
    });
  }

  if (m.crestFactorDb < 6) {
    issues.push({
      severity: "warning",
      code: "low_crest",
      message: `Crest factor is ${m.crestFactorDb} dB — transients are heavily flattened.`,
      suggestion: "Ease the limiter or the master compressor; the kick and snare need their attack back.",
    });
  }

  if (m.channels >= 2) {
    if (m.phaseCorrelation != null && m.phaseCorrelation < 0) {
      issues.push({
        severity: "problem",
        code: "phase_negative",
        message: `Phase correlation is ${m.phaseCorrelation} — the channels are substantially out of phase and content will cancel in mono.`,
        suggestion: "Find the widened element causing it. Club systems are mono in the low end and often mono overall on the dancefloor edges.",
      });
    } else if (m.phaseCorrelation != null && m.phaseCorrelation < 0.3) {
      issues.push({
        severity: "warning",
        code: "phase_loose",
        message: `Phase correlation is ${m.phaseCorrelation} — quite decorrelated. Some of this will disappear in mono.`,
        suggestion: "Check the mix in mono and confirm nothing important vanishes.",
      });
    }

    if (m.lowEndWidth != null && m.lowEndWidth > 0.3) {
      issues.push({
        severity: "problem",
        code: "wide_low_end",
        message: `The low end is wide below 120 Hz (side/mid ratio ${m.lowEndWidth}). Your sub is spread across the stereo field.`,
        suggestion: "Mono everything below roughly 120 Hz. On a club system a wide sub loses power and can cancel outright.",
      });
    }

    if (m.monoCompatibilityDb != null && m.monoCompatibilityDb < -3) {
      issues.push({
        severity: "warning",
        code: "mono_loss",
        message: `Summing to mono drops the level by ${Math.abs(m.monoCompatibilityDb).toFixed(1)} dB — a lot of the mix lives in the sides.`,
        suggestion: "Phone speakers, club monitors and many venue systems are mono. Rebalance so the core of the track survives the sum.",
      });
    }

    if (m.stereoWidth != null && m.stereoWidth < 0.05) {
      issues.push({
        severity: "info",
        code: "narrow",
        message: `Stereo width is ${m.stereoWidth} — effectively mono.`,
        suggestion: "Intentional for some styles. If not, widen pads, percussion and effects while keeping the low end centred.",
      });
    }
  }

  const sub = m.spectrum.find((b) => b.band === "sub");
  const mids = m.spectrum.find((b) => b.band === "mids");
  const air = m.spectrum.find((b) => b.band === "air");
  if (sub && mids && sub.db - mids.db > 12) {
    issues.push({
      severity: "warning",
      code: "sub_heavy",
      message: `The sub band sits ${(sub.db - mids.db).toFixed(1)} dB above the mids — bottom-heavy.`,
      suggestion: "It will sound huge on headphones and muddy on a PA. Check on a small speaker before committing.",
    });
  }
  if (air && mids && mids.db - air.db > 24) {
    issues.push({
      severity: "info",
      code: "dark",
      message: `Very little energy above 8 kHz relative to the mids (${(mids.db - air.db).toFixed(1)} dB down).`,
      suggestion: "Fine for a dark or dub aesthetic; otherwise the track may read as dull next to other records in a set.",
    });
  }

  if (issues.length === 0) {
    issues.push({
      severity: "info",
      code: "clean",
      message: "No technical problems detected in loudness, peaks, dynamics or stereo behaviour.",
      suggestion: "Nothing to fix technically. Judge it on arrangement and sound selection.",
    });
  }
  return issues;
}

function writeSummary(args: {
  loudness: ReturnType<typeof measureLoudness>;
  issues: AudioIssue[];
  bpm: number | null;
  key: { name: string | null; camelot: string | null; confidence: number | null };
  durationSec: number;
}): string {
  const parts: string[] = [];
  const mins = Math.floor(args.durationSec / 60);
  const secs = Math.round(args.durationSec % 60);
  parts.push(`${mins}:${String(secs).padStart(2, "0")} long`);
  if (args.bpm) parts.push(`around ${Math.round(args.bpm)} BPM`);
  if (args.key.name) parts.push(`likely ${args.key.name}${args.key.camelot ? ` (${args.key.camelot})` : ""}`);
  if (args.loudness.integratedLufs != null) parts.push(`${args.loudness.integratedLufs} LUFS integrated`);

  const problems = args.issues.filter((i) => i.severity === "problem");
  const warnings = args.issues.filter((i) => i.severity === "warning");
  const verdict = problems.length
    ? `${problems.length} issue(s) to fix before release: ${problems.map((p) => p.code).join(", ")}.`
    : warnings.length
      ? `Technically sound, with ${warnings.length} thing(s) worth a second listen.`
      : "Technically clean.";

  return `${parts.join(", ")}. ${verdict}`;
}
