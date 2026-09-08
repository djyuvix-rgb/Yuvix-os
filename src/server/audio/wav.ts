/**
 * Minimal RIFF/WAVE decoder.
 *
 * Handles the formats a producer actually exports: PCM 16/24/32-bit integer and
 * 32/64-bit float, mono or stereo, plus WAVE_FORMAT_EXTENSIBLE. Anything else
 * (MP3, AAC, FLAC, MP4) needs decoding first — the analyser detects that and
 * says so rather than returning nonsense numbers.
 */

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
  durationSec: number;
  bitDepth: number;
  format: "pcm" | "float";
}

export class UnsupportedAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedAudioError";
  }
}

export function decodeWav(buffer: Buffer): DecodedAudio {
  if (buffer.length < 44) throw new UnsupportedAudioError("File is too small to be a WAV.");
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new UnsupportedAudioError(
      "Not a WAV file. YUVIX OS analyses WAV and AIFF-style PCM directly; for MP3/FLAC/M4A/MP4, export a WAV (or install ffmpeg and convert first).",
    );
  }

  let offset = 12;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      audioFormat = buffer.readUInt16LE(body);
      numChannels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
      if (audioFormat === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE: the real format sits in the GUID's first two bytes.
        audioFormat = buffer.readUInt16LE(body + 24);
      }
    } else if (id === "data") {
      dataStart = body;
      // Some encoders write 0xFFFFFFFF for streamed files; fall back to the rest of the buffer.
      dataLength = size > 0 && body + size <= buffer.length ? size : buffer.length - body;
    }

    offset = body + size + (size % 2); // chunks are word-aligned
    if (dataStart >= 0 && sampleRate > 0) break;
  }

  if (dataStart < 0 || !sampleRate || !numChannels) throw new UnsupportedAudioError("WAV header is missing fmt or data chunks.");
  if (![1, 3].includes(audioFormat)) {
    throw new UnsupportedAudioError(`Compressed WAV (format code ${audioFormat}) is not supported. Export uncompressed PCM.`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * numChannels));
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frameCount));

  for (let frame = 0; frame < frameCount; frame++) {
    const base = dataStart + frame * bytesPerSample * numChannels;
    for (let ch = 0; ch < numChannels; ch++) {
      const p = base + ch * bytesPerSample;
      let value = 0;
      if (audioFormat === 3) {
        value = bitsPerSample === 64 ? buffer.readDoubleLE(p) : buffer.readFloatLE(p);
      } else if (bitsPerSample === 16) {
        value = buffer.readInt16LE(p) / 32768;
      } else if (bitsPerSample === 24) {
        const raw = buffer[p] | (buffer[p + 1] << 8) | (buffer[p + 2] << 16);
        value = ((raw & 0x800000 ? raw | ~0xffffff : raw) as number) / 8388608;
      } else if (bitsPerSample === 32) {
        value = buffer.readInt32LE(p) / 2147483648;
      } else if (bitsPerSample === 8) {
        value = (buffer[p] - 128) / 128;
      } else {
        throw new UnsupportedAudioError(`Unsupported bit depth: ${bitsPerSample}`);
      }
      channels[ch][frame] = value;
    }
  }

  return {
    sampleRate,
    channels,
    durationSec: frameCount / sampleRate,
    bitDepth: bitsPerSample,
    format: audioFormat === 3 ? "float" : "pcm",
  };
}
