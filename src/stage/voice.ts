// Dialogue audio: loads a run's voices.json + clips, precomputes a loudness envelope per
// clip, and maps the level at the current playback time to a mouth shape.
import type { MouthShape } from './rig';

const FRAME = 1 / 60; // envelope resolution (s)

export interface Clip { buffer: AudioBuffer; env: Float32Array; duration: number }

export async function loadVoices(ctx: BaseAudioContext, base: string): Promise<Record<number, Clip>> {
  const out: Record<number, Clip> = {};
  let manifest: { turns: Record<string, { file: string }> };
  try {
    const r = await fetch(`${base}/voices.json?t=${Date.now()}`);
    if (!r.ok) return out;
    manifest = await r.json();
  } catch { return out; }
  await Promise.all(Object.entries(manifest.turns).map(async ([turn, v]) => {
    try {
      const data = await (await fetch(`${base}/${v.file}`)).arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      out[Number(turn)] = { buffer, env: envelope(buffer), duration: buffer.duration };
    } catch { /* missing or undecodable clip → that line uses the mouth-cycle fallback */ }
  }));
  return out;
}

/** RMS per frame, normalised so the loud syllables of this clip sit near 1. */
function envelope(b: AudioBuffer): Float32Array {
  const d = b.getChannelData(0), n = Math.max(1, Math.floor(b.sampleRate * FRAME));
  const env = new Float32Array(Math.ceil(d.length / n));
  for (let i = 0; i < env.length; i++) {
    let sum = 0;
    const end = Math.min(d.length, (i + 1) * n);
    for (let j = i * n; j < end; j++) sum += d[j] * d[j];
    env[i] = Math.sqrt(sum / Math.max(1, end - i * n));
  }
  const sorted = Array.from(env).sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.95)] || 1;
  for (let i = 0; i < env.length; i++) env[i] = Math.min(1, env[i] / ref);
  return env;
}

/** Mouth for a clip at time t (s): closed in silence, slightly open when quiet, wide on loud syllables. */
export function mouthFromLevel(clip: Clip, t: number): MouthShape {
  if (t < 0 || t >= clip.duration) return 'closed';
  const i = Math.floor(t / FRAME);
  // small look-around smooths single-frame flicker
  const v = Math.max(clip.env[i] ?? 0, ((clip.env[i - 1] ?? 0) + (clip.env[i + 1] ?? 0)) / 2);
  if (v < 0.14) return 'closed';
  if (v < 0.55) return 'open';
  return 'wide';
}

/** Fallback when no audio level is available: a simple talk cycle, then closed. */
export function mouthCycle(t: number, duration: number): MouthShape {
  if (t < 0 || t >= duration) return 'closed';
  const k = Math.floor(t / 0.11) % 4;
  return (['open', 'wide', 'open', 'closed'] as MouthShape[])[k];
}

/** Rough spoken length for a line with no audio. */
export const fallbackDuration = (line: string) => Math.max(1.5, line.length * 0.06);
