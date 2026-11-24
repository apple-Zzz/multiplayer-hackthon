#!/usr/bin/env node
// Placeholder dialogue audio: renders each recorded spoken_line with macOS `say`
// (one voice per character) to <run dir>/voices/turn-NN.m4a plus voices.json.
// Swap any file for a real recording with the same name; the stage reads levels
// from whatever audio is there and falls back to a mouth cycle if a file is missing.
//
//   node stage/voices.mjs                       latest run (performance/)
//   node stage/voices.mjs performance/runs/run-01
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { nameify } from './display.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VOICES = { A: 'Reed (English (US))', B: 'Moira', C: 'Karen' };
const RATE = 190; // words per minute

/** Render one line into <voiceDir>/turn-NN.m4a and add it to voiceDir/voices.json (used live, turn by turn). */
export function renderLine(voiceDir, turn, who, line) {
  if (process.platform !== 'darwin' || !line) return null;
  mkdirSync(voiceDir, { recursive: true });
  const name = `turn-${String(turn).padStart(2, '0')}.m4a`;
  const aiff = join(tmpdir(), `third-survivor-${process.pid}-${turn}.aiff`);
  if (spawnSync('say', ['-v', VOICES[who], '-r', String(RATE), '-o', aiff, '--', line]).status !== 0) return null;
  const ok = spawnSync('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, join(voiceDir, name)]).status === 0;
  rmSync(aiff, { force: true });
  if (!ok) return null;
  const duration = Number(spawnSync('afinfo', [join(voiceDir, name)]).stdout.toString().match(/estimated duration: ([\d.]+)/)?.[1] ?? 0);
  const mf = join(voiceDir, 'voices.json');
  const manifest = existsSync(mf) ? JSON.parse(readFileSync(mf, 'utf8')) : { voices: VOICES, turns: {} };
  manifest.turns[turn] = { file: name, actor: who, duration };
  writeFileSync(mf, JSON.stringify(manifest, null, 2));
  return manifest.turns[turn];
}

export function renderVoices(dir) {
  if (process.platform !== 'darwin') { console.error('voices: macOS `say` not available; the stage will use the mouth-cycle fallback.'); return false; }
  const rec = JSON.parse(readFileSync(join(dir, 'decision-record.json'), 'utf8'));
  const out = join(dir, 'voices');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const manifest = { voices: VOICES, turns: {} };
  for (const t of rec.turns) {
    if (!t.spoken_line) continue;
    const name = `turn-${String(t.turn).padStart(2, '0')}.m4a`;
    const aiff = join(tmpdir(), `third-survivor-${process.pid}-${t.turn}.aiff`);
    const text = rec.rules ? t.spoken_line : nameify(t.spoken_line);   // legacy lines say the display names too
    const say = spawnSync('say', ['-v', VOICES[t.actor], '-r', String(RATE), '-o', aiff, '--', text]);
    if (say.status !== 0) { console.error(`voices: say failed on turn ${t.turn}: ${say.stderr}`); continue; }
    const conv = spawnSync('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, join(out, name)]);
    rmSync(aiff, { force: true });
    if (conv.status !== 0) { console.error(`voices: afconvert failed on turn ${t.turn}: ${conv.stderr}`); continue; }
    const info = spawnSync('afinfo', [join(out, name)]).stdout.toString();
    const duration = Number(info.match(/estimated duration: ([\d.]+)/)?.[1] ?? 0);
    manifest.turns[t.turn] = { file: name, actor: t.actor, duration };
  }
  writeFileSync(join(out, 'voices.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? join(ROOT, process.argv[2]) : join(ROOT, 'performance');
  if (!existsSync(join(dir, 'decision-record.json'))) { console.error(`No decision-record.json in ${dir}`); process.exit(1); }
  const m = renderVoices(dir);
  if (m) {
    const total = Object.values(m.turns).reduce((a, v) => a + v.duration, 0);
    console.log(`Wrote ${Object.keys(m.turns).length} lines to ${join(dir, 'voices')} (${total.toFixed(1)}s of dialogue)`);
  }
}
