// Archives a finished run: performance/runs/<id>/ (record, private bids, policy trace, rewards,
// meta, voices, script, decision log), the latest copies in performance/, the run index, and
// (optionally) refreshes the Bruin tables + insights.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDS, NAMES } from './world.mjs';
import { exportRun } from './export.mjs';
import { runInsights } from './insights.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = join(ROOT, 'performance', 'runs');
const INDEX = join(RUNS, 'index.json');   // not under public/ (the dev server reloads pages when public/ changes)
const save = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };

export function nextRunId() {
  const used = existsSync(RUNS) ? readdirSync(RUNS).map((d) => Number(d.match(/^run-(\d+)$/)?.[1] ?? 0)) : [];
  return `run-${String(Math.max(0, ...used) + 1).padStart(2, '0')}`;
}

export function archiveRun({ state: s, meta, bids, traces, bruin = true, voiceDir = null, latest = true }) {
  // claim the run id atomically (mkdir fails if another run took it first)
  let id, dir;
  for (;;) {
    id = nextRunId(); dir = join(RUNS, id);
    try { mkdirSync(RUNS, { recursive: true }); mkdirSync(dir); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const record = { run_id: id, rules: 'v3', names: NAMES, meta, hidden: meta.hidden, order: [], turns: s.record, ending: s.ending };
  save(join(dir, 'decision-record.json'), record);
  save(join(dir, 'bids.json'), bids);                 // private: never shown on stage
  save(join(dir, 'policy-trace.json'), traces);
  save(join(dir, 'rewards.json'), Object.fromEntries(IDS.map((p) => [p, { name: NAMES[p], status: s.ending.status[p], how: s.ending.how[p], ...s.ending.reward[p], goal_met: s.ending.goal[p].met, goal_detail: s.ending.goal[p].detail }])));
  save(join(dir, 'meta.json'), { run_id: id, ...meta });
  const liveVoices = voiceDir ?? join(ROOT, 'performance', 'voices');
  if (existsSync(join(liveVoices, 'voices.json'))) cpSync(liveVoices, join(dir, 'voices'), { recursive: true });
  // latest run = what the stage plays by default
  if (latest) save(join(ROOT, 'performance', 'decision-record.json'), record);
  exportRun(dir, id);
  if (latest) exportRun(join(ROOT, 'performance'), id);
  const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : [];
  save(INDEX, [...index.filter((r) => r.id !== id), {
    id, rules: 'v3', mode: meta.mode, seed: meta.seed, finishedAt: meta.finished, hidden: meta.hidden,
    status: s.ending.status, rescued: s.ending.rescued, sheltered: s.ending.sheltered,
  }]);
  if (bruin) {
    try { runInsights(); } catch (e) { console.error(`insights: ${e.message}`); }
  }
  return id;
}

/** Remove a run (used to discard smoke tests). */
export function removeRun(id) {
  rmSync(join(RUNS, id), { recursive: true, force: true });
  if (existsSync(INDEX)) save(INDEX, JSON.parse(readFileSync(INDEX, 'utf8')).filter((r) => r.id !== id));
}
