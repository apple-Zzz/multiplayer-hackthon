// Lightweight per-character reinforcement learning (tabular, Monte-Carlo).
//
// The language model still writes each character's options (dialogue, deals, actions).
// The policy only decides WHICH of the character's valid candidate actions is performed,
// using learned values for (situation the character knows, intent). Values persist in
// performance/policy/policy.json. Modes:
//   baseline — the starting policy (all values 0): always the agent's own first choice
//   train    — learned values + exploration; updated after the run
//   learned  — learned values, greedy, frozen (evaluation)
//   showcase — like learned (greedy, frozen) but not counted in the training statistics
//   replay   — not used: replays read the record and never touch the policy
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rngNext, IDS } from './world.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const POLICY_DIR = join(ROOT, 'performance', 'policy');
export const POLICY_FILE = join(POLICY_DIR, 'policy.json');
const RANK_PRIOR = [0.6, 0.3, 0];   // respect the agent's own preference order
const VALUE_WEIGHT = 1.0;
const TEMPERATURE = 0.35;
const EPSILON = 0.2;                // exploration during training
const MIN_STEP = 0.25;              // learning-rate floor for the running average

export const emptyPolicy = () => ({ version: 0, trained_runs: 0, Q: { A: {}, B: {}, C: {} }, history: [] });

export function loadPolicy(mode) {
  if (mode === 'baseline') return emptyPolicy();
  return existsSync(POLICY_FILE) ? JSON.parse(readFileSync(POLICY_FILE, 'utf8')) : emptyPolicy();
}
export function savePolicy(p) {
  mkdirSync(POLICY_DIR, { recursive: true });
  writeFileSync(POLICY_FILE, JSON.stringify(p, null, 2));
}

/** Situation key built only from facts this character actually knows. */
export function stateKey(s, who) {
  const f = s.facts[who];
  const bottle = s.holdings[who].some((i) => i.startsWith('bottle')) ? 1 : 0;
  const loc = { wreckage: 'wreck', shoreline: 'shore', dry_spot: 'dry' }[s.positions[who]];
  return `loc=${loc}|radio=${f.radio}|call=${f.call ? 1 : 0}|water=${f.water}|shelter=${s.shelter.built ? 1 : 0}|bottle=${bottle}`;
}

function value(policy, who, key, intent) {
  const exact = policy.Q[who]?.[key]?.[intent];
  if (exact?.n) return exact.v;
  const general = policy.Q[who]?.['*']?.[intent];   // intent value across situations (generalises from few runs)
  return general?.n ? 0.5 * general.v : 0;
}

/**
 * Pick one of the character's valid candidates. Returns { index, explored, trace }.
 * candidates: [{ intent, ... }] in the agent's preference order.
 */
export function choose(policy, s, who, candidates, mode) {
  const key = stateKey(s, who);
  const rows = candidates.map((c, i) => {
    const q = mode === 'baseline' ? 0 : value(policy, who, key, c.intent);
    return { intent: c.intent, rank: i, prior: RANK_PRIOR[i] ?? 0, q: +q.toFixed(3), score: +((RANK_PRIOR[i] ?? 0) + VALUE_WEIGHT * q).toFixed(3) };
  });
  let index = 0, explored = false;
  if (mode === 'train') {
    if (rows.length > 1 && rngNext(s) < EPSILON) { index = Math.floor(rngNext(s) * rows.length); explored = true; }
    else {
      const w = rows.map((r) => Math.exp(r.score / TEMPERATURE)), total = w.reduce((a, b) => a + b, 0);
      let x = rngNext(s) * total; index = 0;
      while (index < w.length - 1 && (x -= w[index]) > 0) index++;
    }
  } else {
    index = rows.reduce((best, r, i) => (r.score > rows[best].score ? i : best), 0);
  }
  return { index, explored, trace: { who, key, mode, rows, chosen: index, explored } };
}

/** Monte-Carlo update after a training run: each (situation, intent) the character chose moves toward that character's return. */
export function update(policy, traces, rewards, runId) {
  for (const t of traces) {
    const G = rewards[t.who].total;
    const intent = t.rows[t.chosen].intent;
    for (const key of [t.key, '*']) {
      const cell = ((policy.Q[t.who][key] ??= {})[intent] ??= { v: 0, n: 0 });
      cell.n += 1;
      cell.v = +(cell.v + Math.max(MIN_STEP, 1 / cell.n) * (G - cell.v)).toFixed(4);
    }
  }
  policy.version += 1;
  policy.trained_runs += 1;
  policy.history.push({ run: runId, rewards: Object.fromEntries(IDS.map((p) => [p, rewards[p]])) });
  return policy;
}
