import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { prisma } from "@/server/db/client";
import { toJson } from "@/server/db/json";
import { analyzeAudioFile } from "@/server/audio/analyze";
import { resolveInWorkspace } from "@/server/files/workspace";

export const audioTools = [
  defineTool({
    name: "audio_analyze",
    group: "audio",
    autonomy: "level1",
    description:
      "Measure an audio file: integrated LUFS (ITU-R BS.1770-4), short-term max, loudness range, true peak, sample peak, crest factor, stereo width, phase correlation, mono compatibility, low-end width below 120 Hz, octave-band spectrum, clipping, plus BPM and key estimates with confidence values. " +
      "Reads uncompressed WAV. Results are stored against the track when trackId is given. " +
      "When you report the results, explain them in plain language ('your sub is spread across the stereo field and will lose power on a club system'), not as a table of numbers. " +
      "These are measurements from a DSP engine, not a mastering certification — never present them as a professional mastering opinion.",
    schema: z.object({
      path: z.string().describe("Workspace-relative path to a .wav file, e.g. 'Music/Masters/yaka-master.wav'"),
      trackId: z.string().optional(),
    }),
    async execute(input) {
      const full = resolveInWorkspace(input.path);
      const result = await analyzeAudioFile(full);

      const analysis = await prisma.audioAnalysis.create({
        data: {
          trackId: input.trackId ?? null,
          filePath: input.path,
          fileHash: result.fileHash,
          format: result.format,
          sampleRate: result.sampleRate,
          channels: result.channels,
          durationSec: result.durationSec,
          bpm: result.bpm,
          musicalKey: result.musicalKey,
          lufsIntegrated: result.lufsIntegrated,
          lufsShortTermMax: result.lufsShortTermMax,
          truePeakDb: result.truePeakDb,
          samplePeakDb: result.samplePeakDb,
          dynamicRangeDb: result.dynamicRangeDb,
          crestFactorDb: result.crestFactorDb,
          stereoWidth: result.stereoWidth,
          phaseCorrelation: result.phaseCorrelation,
          monoCompatibilityDb: result.monoCompatibilityDb,
          lowEndWidth: result.lowEndWidth,
          spectrumJson: toJson(result.spectrum),
          clippedSamples: result.clippedSamples,
          issuesJson: toJson(result.issues),
          summary: result.summary,
        },
      });

      // Fill in track metadata only where it is still blank — never overwrite
      // what the producer entered with an estimate.
      if (input.trackId) {
        const track = await prisma.track.findUnique({ where: { id: input.trackId } });
        if (track) {
          await prisma.track.update({
            where: { id: track.id },
            data: {
              bpm: track.bpm ?? (result.bpmConfidence && result.bpmConfidence > 0.5 ? result.bpm : undefined),
              musicalKey: track.musicalKey ?? (result.keyConfidence && result.keyConfidence > 0.5 ? result.camelot : undefined),
              durationSec: track.durationSec ?? Math.round(result.durationSec),
            },
          });
        }
      }

      return {
        analysisId: analysis.id,
        file: input.path,
        technical: {
          format: result.format,
          sampleRate: result.sampleRate,
          channels: result.channels,
          durationSec: result.durationSec,
        },
        musical: {
          bpm: result.bpm,
          bpmConfidence: result.bpmConfidence,
          key: result.musicalKey,
          camelot: result.camelot,
          keyConfidence: result.keyConfidence,
          note: "BPM and key are estimated from the signal. Below ~0.5 confidence, treat them as a hint and confirm in the DAW.",
        },
        loudness: {
          integratedLufs: result.lufsIntegrated,
          shortTermMaxLufs: result.lufsShortTermMax,
          loudnessRangeLu: result.loudnessRangeLu,
          truePeakDb: result.truePeakDb,
          samplePeakDb: result.samplePeakDb,
          crestFactorDb: result.crestFactorDb,
          truePeakNote: "True peak is a 4x-oversampled estimate, accurate to roughly 0.1 dB — not a certified meter.",
        },
        stereo: {
          width: result.stereoWidth,
          phaseCorrelation: result.phaseCorrelation,
          monoCompatibilityDb: result.monoCompatibilityDb,
          lowEndWidthBelow120Hz: result.lowEndWidth,
        },
        spectrum: result.spectrum,
        clippedSamples: result.clippedSamples,
        issues: result.issues,
        summary: result.summary,
      };
    },
  }),

  defineTool({
    name: "audio_analysis_history",
    group: "audio",
    autonomy: "level1",
    readOnly: true,
    description: "Retrieve past audio analyses for a track, so successive masters can be compared objectively rather than by memory.",
    schema: z.object({ trackId: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }),
    async execute(input) {
      const rows = await prisma.audioAnalysis.findMany({
        where: input.trackId ? { trackId: input.trackId } : {},
        orderBy: { createdAt: "desc" },
        take: input.limit ?? 10,
      });
      return {
        count: rows.length,
        analyses: rows.map((a) => ({
          id: a.id,
          file: a.filePath,
          analysedAt: a.createdAt.toISOString().slice(0, 10),
          lufs: a.lufsIntegrated,
          truePeakDb: a.truePeakDb,
          crestFactorDb: a.crestFactorDb,
          lowEndWidth: a.lowEndWidth,
          phaseCorrelation: a.phaseCorrelation,
          summary: a.summary,
        })),
      };
    },
  }),
];
