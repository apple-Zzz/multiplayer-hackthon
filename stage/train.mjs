#!/usr/bin/env node
// Train + evaluate the per-character policies.
//   1. Starting policy (all values 0 = each agent's own first choice) on the EVAL seeds.
//   2. Training runs (exploration on, policy updated after each run) on the TRAIN seeds.
//   3. Learned policy (greedy, frozen) on the same EVAL seeds.
// Every run is archived like any other (mode baseline / train / learned), Bruin is refreshed,
// and performance/insights/training-report.md reports measured rates per character with run counts.
//
//   node stage/train.mjs [--eval 103,105,109,101] [--train 120,122,126,128,110,117] [--model haiku] [--fresh] [--phases baseline,train,learned]
import { existsSync, renameSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPerformance } from './orchestrate.mjs';
import { POLICY_FILE, savePolicy, emptyPolicy } from './policy.mjs';
import { runInsights } from './insights.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const EVAL = arg('eval', '103,105,109,101').split(',').map(Number);
const TRAIN = arg('train', '120,122,126,128,110,117').split(',').map(Number);
const MODEL = arg('model', 'haiku');

if (process.argv.includes('--fresh') && existsSync(POLICY_FILE)) {
  renameSync(POLICY_FILE, POLICY_FILE.replace('.json', `.before-${Date.now()}.json`));
}
if (!existsSync(POLICY_FILE)) savePolicy(emptyPolicy());

const runs = [];
let cost = 0;
const PHASES = arg('phases', 'baseline,train,learned').split(',');   // resume an interrupted batch with e.g. --phases train,learned
for (const [mode, seeds] of [['baseline', EVAL], ['train', TRAIN], ['learned', EVAL]].filter(([m]) => PHASES.includes(m))) {
  for (const seed of seeds) {
    const r = await runPerformance({ seed, mode, model: MODEL, voices: true, bruin: false });
    runs.push({ id: r.runId, mode, seed });
    cost += r.meta.cost_usd;
  }
}
runInsights();

// measured comparison, straight from Bruin's insights.training table
const agg = JSON.parse(readFileSync(join(ROOT, 'performance', 'insights', 'aggregate.json'), 'utf8'));
const rows = agg.training;
const L = ['# Policy training report', '', `Model: ${MODEL}. Evaluation seeds: ${EVAL.join(', ')}. Training seeds: ${TRAIN.join(', ')}. Agent cost for this batch: $${cost.toFixed(2)}.`, ''];
L.push('Same evaluation seeds before (starting policy) and after (learned policy, frozen). Rates are over runs; n = number of runs behind each rate.', '');
L.push('| Character | Policy | n | Survival rate | Goal rate | Mean survival reward | Mean goal reward |', '|---|---|---|---|---|---|---|');
for (const r of rows) L.push(`| ${r.character} | ${r.phase} | ${r.runs} | ${(r.survival_rate * 100).toFixed(0)}% | ${(r.goal_rate * 100).toFixed(0)}% | ${r.mean_survival_reward} | ${r.mean_goal_reward} |`);
L.push('', '## Change (learned − starting)', '');
for (const c of ['Sam', 'Welsy', 'Elizabeth']) {
  const b = rows.find((r) => r.character === c && r.phase === 'starting policy');
  const a = rows.find((r) => r.character === c && r.phase === 'learned policy');
  if (!b || !a) continue;
  const d = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)} pts`;
  L.push(`- **${c}:** survival ${(b.survival_rate * 100).toFixed(0)}% → ${(a.survival_rate * 100).toFixed(0)}% (${d(a.survival_rate - b.survival_rate)}), goal ${(b.goal_rate * 100).toFixed(0)}% → ${(a.goal_rate * 100).toFixed(0)}% (${d(a.goal_rate - b.goal_rate)}); n = ${b.runs} vs ${a.runs}.`);
}
L.push('', `With ${EVAL.length} evaluation runs per policy these rates move in steps of ${Math.round(100 / EVAL.length)} points and the agents themselves are not deterministic, so treat differences as indicative, not significant.`, '');
L.push('## Runs', '', ...runs.map((r) => `- ${r.id}: ${r.mode}, seed ${r.seed}`));
mkdirSync(join(ROOT, 'performance', 'insights'), { recursive: true });
writeFileSync(join(ROOT, 'performance', 'insights', 'training-report.md'), L.join('\n') + '\n');
console.log(L.join('\n'));
