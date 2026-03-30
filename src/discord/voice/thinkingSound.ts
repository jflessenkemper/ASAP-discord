/**
 * Thinking chime for Riley's voice chat.
 *
 * Plays a soft three-tone ascending chime when Riley starts processing
 * a voice input — similar to how Grok Voice and ChatGPT voice modes
 * acknowledge user speech before generating a response.
 *
 * Generated entirely from math — no external files or APIs needed.
 * Cached after first call so subsequent calls are near-zero overhead.
 */

const SAMPLE_RATE = 48_000;
const CHANNELS = 2; // stereo
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

interface ToneConfig {
  /** Fundamental frequency in Hz */
  frequency: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Peak amplitude as a fraction of 32767 (0.0 – 1.0) */
  amplitudeMax: number;
  /** Fraction of duration spent fading in (0.0 – 1.0) */
  fadeInRatio: number;
  /** Fraction of duration spent fading out (0.0 – 1.0) */
  fadeOutRatio: number;
}

/**
 * Generate a single sine-wave tone as an array of mono 16-bit PCM samples.
 * Includes a subtle harmonic overtone (2× frequency at 30%) for richness.
 */
function generateTone(config: ToneConfig): number[] {
  const numSamples = Math.floor(SAMPLE_RATE * config.durationMs / 1000);
  const samples: number[] = [];

  for (let i = 0; i < numSamples; i++) {
    const t = i / numSamples; // normalised position 0→1

    // ADSR-style amplitude envelope
    let envelope: number;
    if (t < config.fadeInRatio) {
      // Ease-in using a squared curve for a softer attack
      const p = t / config.fadeInRatio;
      envelope = p * p;
    } else if (t > 1.0 - config.fadeOutRatio) {
      // Ease-out — linear decay is natural for bell-like tones
      envelope = (1.0 - t) / config.fadeOutRatio;
    } else {
      envelope = 1.0;
    }

    const time = i / SAMPLE_RATE;
    const fundamental = Math.sin(2 * Math.PI * config.frequency * time);
    // Subtle harmonic adds warmth without being harsh
    const harmonic2 = Math.sin(2 * Math.PI * config.frequency * 2 * time) * 0.25;

    // Sum and normalise so combined peak ≈ amplitudeMax × 32767
    const combined = (fundamental + harmonic2) / 1.25;
    const sample = combined * envelope * config.amplitudeMax * 32_767;
    samples.push(Math.round(sample));
  }

  return samples;
}

/** Generate silence as an array of zero-valued samples. */
function silence(durationMs: number): number[] {
  return new Array(Math.floor(SAMPLE_RATE * durationMs / 1000)).fill(0);
}

/**
 * Pack an array of mono 16-bit PCM samples into a WAV buffer.
 * Output: 48 kHz, stereo, 16-bit little-endian PCM.
 * Both channels carry the same signal (mono-to-stereo upmix).
 */
function samplesToWav(monoSamples: number[]): Buffer {
  const numSamples = monoSamples.length;
  const dataSize = numSamples * CHANNELS * BYTES_PER_SAMPLE;
  const buffer = Buffer.alloc(44 + dataSize);
  let o = 0;

  // RIFF chunk descriptor
  buffer.write('RIFF', o);              o += 4;
  buffer.writeUInt32LE(36 + dataSize, o); o += 4;
  buffer.write('WAVE', o);              o += 4;

  // fmt sub-chunk
  buffer.write('fmt ', o);             o += 4;
  buffer.writeUInt32LE(16, o);         o += 4; // sub-chunk size (always 16 for PCM)
  buffer.writeUInt16LE(1, o);          o += 2; // audio format PCM = 1
  buffer.writeUInt16LE(CHANNELS, o);   o += 2;
  buffer.writeUInt32LE(SAMPLE_RATE, o); o += 4;
  // byte rate = sampleRate × channels × bytesPerSample
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, o); o += 4;
  // block align = channels × bytesPerSample
  buffer.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, o); o += 2;
  buffer.writeUInt16LE(BITS_PER_SAMPLE, o); o += 2;

  // data sub-chunk
  buffer.write('data', o);             o += 4;
  buffer.writeUInt32LE(dataSize, o);   o += 4;

  for (const sample of monoSamples) {
    const clamped = Math.max(-32_768, Math.min(32_767, sample));
    buffer.writeInt16LE(clamped, o);     o += 2; // left channel
    buffer.writeInt16LE(clamped, o);     o += 2; // right channel
  }

  return buffer;
}

// Generated once at startup; subsequent calls return the cached buffer.
let cachedChime: Buffer | null = null;

/**
 * Get the thinking chime WAV buffer.
 *
 * The chime is a three-tone ascending sequence (E5 → G5 → C6) at low
 * volume (~15–20% of max), designed to be audible but non-intrusive —
 * it simply signals "I heard you, I'm thinking."
 *
 * Total duration: ≈ 750 ms
 * Format: WAV, 48 kHz, stereo, 16-bit PCM
 */
export function getThinkingChime(): Buffer {
  if (cachedChime) return cachedChime;

  // Tone 1 — E5 (659 Hz) — first note, softest
  const tone1 = generateTone({
    frequency: 659,
    durationMs: 170,
    amplitudeMax: 0.15,
    fadeInRatio: 0.12,
    fadeOutRatio: 0.30,
  });

  // Short gap between notes
  const gap1 = silence(45);

  // Tone 2 — G5 (784 Hz) — bridging note
  const tone2 = generateTone({
    frequency: 784,
    durationMs: 175,
    amplitudeMax: 0.17,
    fadeInRatio: 0.10,
    fadeOutRatio: 0.30,
  });

  // Short gap between notes
  const gap2 = silence(45);

  // Tone 3 — C6 (1047 Hz) — final note, slightly louder for resolution
  const tone3 = generateTone({
    frequency: 1047,
    durationMs: 230,
    amplitudeMax: 0.20,
    fadeInRatio: 0.10,
    fadeOutRatio: 0.45, // long fade-out for a bell-like ring
  });

  // Short tail of silence so discord playback doesn't clip at the end
  const tail = silence(70);

  cachedChime = samplesToWav([...tone1, ...gap1, ...tone2, ...gap2, ...tone3, ...tail]);
  return cachedChime;
}
