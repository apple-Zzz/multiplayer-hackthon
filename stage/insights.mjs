#!/usr/bin/env node
// All completed runs → Bruin → insights.
//  1. Build seed CSVs for every run in performance/runs/: turns, outcomes, learning rewards.
//  2. `bruin run` the pipeline (bruin/third-survivor) into DuckDB.
//  3. Read the insight tables back with `bruin query -o json` and write
//     performance/insights/runs/<run>.json (per-run summary, also summary.md in the run dir)
//     and performance/insights/aggregate.json (across runs). The stage's insights panel reads these.
//
//   node stage/insights.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NAMES, STATUS_LABEL, nameify as legacyNames, statusesOf, goalsOf } from './display.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = join(ROOT, 'performance', 'runs');
const ASSETS = join(ROOT, 'bruin', 'third-survivor', 'assets');
const OUT = join(ROOT, 'performance', 'insights');
const BRUIN = existsSync(join(homedir(), '.local', 'bin', 'bruin')) ? join(homedir(), '.local', 'bin', 'bruin') : 'bruin';
const IDS = ['A', 'B', 'C'];

const csv = (rows) => rows.map((r) => r.map((v) => {
  if (v === null || v === undefined) return '';
  const t = String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}).join(',')).join('\n') + '\n';
const words = (s) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);

function loadRuns() {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS).filter((d) => /^run-\d+$/.test(d) && existsSync(join(RUNS, d, 'decision-record.json'))).sort().map((id) => {
    const rec = JSON.parse(readFileSync(join(RUNS, id, 'decision-record.json'), 'utf8'));
    const meta = existsSync(join(RUNS, id, 'meta.json')) ? JSON.parse(readFileSync(join(RUNS, id, 'meta.json'), 'utf8')) : { mode: 'legacy', seed: null, rules: 'v1' };
    return { id, rec, meta, rules: rec.rules ?? 'v1' };
  }).filter((r) => r.rec.ending && r.rec.turns?.length);
}

export function buildCsvs(runs = loadRuns()) {
  const turns = [['run_id', 'rules', 'mode', 'seed', 'turn', 'agent_id', 'agent', 'speaker', 'action', 'target', 'intent', 'spoken_line', 'spoken_words',
    'stage_direction', 'visible_action', 'gesture', 'previous_plan', 'current_plan', 'plan_changed', 'influenced_by_turn', 'reason', 'state_change', 'storm', 'selected_by']];
  const outcomes = [['run_id', 'rules', 'mode', 'seed', 'character_id', 'character', 'status', 'status_label', 'how', 'survived', 'goal_met', 'goal_score', 'goal_detail',
    'final_spot', 'mobility', 'radio', 'water', 'boat_arrived', 'shelter_built']];
  const rewards = [['run_id', 'mode', 'seed', 'character_id', 'character', 'survival_reward', 'goal_reward', 'total_reward', 'policy_version', 'learning_updated']];
  for (const { id, rec, meta, rules } of runs) {
    const nameify = rules !== 'v1' ? (x) => x : legacyNames;   // only v1 text used letters as names
    for (const t of rec.turns) {
      const speaker = t.spoken_line ? (t.speaker ?? t.actor) : null;
      turns.push([id, rules, meta.mode, meta.seed, t.turn, t.actor, NAMES[t.actor], speaker ? NAMES[speaker] : null, t.action ?? t.event.type,
        nameify(t.target ?? t.event.recipient ?? t.event.item ?? (t.event.to !== t.event.from ? t.event.to : null)), t.intent ?? null,
        nameify(t.spoken_line), words(t.spoken_line), nameify(t.stage_direction || t.visible_action), nameify(t.visible_action), t.gesture ?? null,
        nameify(t.previous_plan), nameify(t.current_plan), !!t.plan_changed, t.influenced_by_turn ?? null, nameify(t.reason), nameify(t.state_change), t.storm, t.selected_by ?? null]);
    }
    const e = rec.ending, st = statusesOf(e), goals = goalsOf(e);
    const last = rec.turns[rec.turns.length - 1].snapshot;
    for (const p of IDS) {
      outcomes.push([id, rules, meta.mode, meta.seed, p, NAMES[p], st.status[p], STATUS_LABEL[st.status[p]], st.how[p],
        st.status[p] === 'rescued' || st.status[p] === 'sheltered_survived', goals[p].met, goals[p].score, goals[p].detail,
        last.positions[p], e.hidden.mobility, e.hidden.radio, e.hidden.water, !!(e.boatArrives ?? e.rescued?.length), !!last.shelterBuilt]);
      if (e.reward) rewards.push([id, meta.mode, meta.seed, p, NAMES[p], e.reward[p].survival, e.reward[p].goal, e.reward[p].total, meta.policy_version ?? 0, meta.mode === 'train']);
    }
  }
  mkdirSync(ASSETS, { recursive: true });
  writeFileSync(join(ASSETS, 'turns.csv'), csv(turns));
  writeFileSync(join(ASSETS, 'outcomes.csv'), csv(outcomes));
  writeFileSync(join(ASSETS, 'rewards.csv'), csv(rewards));
  return { runs: runs.length, turns: turns.length - 1 };
}

function bruin(args) {
  const r = spawnSync(BRUIN, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`bruin ${args[0]} failed: ${(r.stderr || r.stdout).slice(-800)}`);
  return r.stdout;
}
function query(sql) {
  const out = bruin(['query', '--connection', 'duckdb-default', '-o', 'json', '--query', sql, '--description', 'Third Survivor insights panel']);
  const j = JSON.parse(out.slice(out.indexOf('{')));
  return (j.rows ?? []).map((row) => Object.fromEntries(j.columns.map((c, i) => [c.name, row[i]])));
}

export function runInsights() {
  const runs = loadRuns();
  buildCsvs(runs);
  bruin(['run', 'bruin/third-survivor']);
  const speaking = query('select * from insights.speaking order by run_id, agent');
  const overall = query('select * from insights.speaking_overall order by spoken_turns desc, spoken_words desc');
  const changes = query('select * from insights.plan_changes order by run_id, turn');
  const survival = query('select * from insights.survival order by run_id, character_id');
  const training = query('select * from insights.training order by character_id, phase_order');
  mkdirSync(join(OUT, 'runs'), { recursive: true });
  const aggregate = { generated: new Date().toISOString(), runs: runs.map((r) => ({ id: r.id, mode: r.meta.mode, seed: r.meta.seed, rules: r.rules })), speaking: overall, training };
  writeFileSync(join(OUT, 'aggregate.json'), JSON.stringify(aggregate, null, 2));
  for (const { id } of runs) {
    const sp = speaking.filter((r) => r.run_id === id);
    const summary = {
      run_id: id, mode: runs.find((r) => r.id === id).meta.mode,
      speaking: sp,
      most_spoken_by_turns: [...sp].sort((a, b) => b.spoken_turns - a.spoken_turns)[0]?.agent ?? null,
      most_spoken_by_words: [...sp].sort((a, b) => b.spoken_words - a.spoken_words)[0]?.agent ?? null,
      plan_changes: changes.filter((r) => r.run_id === id),
      survival: survival.filter((r) => r.run_id === id),
    };
    writeFileSync(join(OUT, 'runs', `${id}.json`), JSON.stringify(summary, null, 2));
    writeFileSync(join(RUNS, id, 'summary.md'), summaryMarkdown(summary, training));
  }
  return { runs: runs.length };
}

function summaryMarkdown(s, training) {
  const L = [`# ${s.run_id}: insights (from Bruin)`, ''];
  L.push('## Who spoke the most', '', '| Character | Turns taken | Spoken turns | Words spoken |', '|---|---|---|---|');
  for (const r of s.speaking) L.push(`| ${r.agent} | ${r.turns_taken} | ${r.spoken_turns} | ${r.spoken_words} |`);
  L.push('', `Most spoken turns: **${s.most_spoken_by_turns}**. Most words: **${s.most_spoken_by_words}**.`, '');
  L.push('## Plan changes', '');
  if (!s.plan_changes.length) L.push('No one changed plan in this run.');
  for (const c of s.plan_changes) {
    L.push(`- **Turn ${c.turn}, ${c.agent}** changed plan${c.prompted_by_turn ? `, prompted by turn ${c.prompted_by_turn} (${c.prompted_by_agent}): *${c.prompt_stage_direction}*${c.prompt_line ? ` ${c.prompted_by_agent}: "${c.prompt_line}"` : ''}` : ' (no earlier turn cited)'}`);
    L.push(`  In ${c.agent}'s words: "${c.reason}"`);
  }
  L.push('', '## Survival and goals', '');
  for (const r of s.survival) L.push(`- **${r.character}:** ${r.status_label}: ${r.how}. Goal ${r.goal_met ? 'met' : 'not met'} (${r.goal_detail}).`);
  L.push('', '## Training comparison (all runs so far)', '', '| Character | Policy | Runs | Survival rate | Goal rate | Mean reward |', '|---|---|---|---|---|---|');
  for (const r of training) L.push(`| ${r.character} | ${r.phase} | ${r.runs} | ${(r.survival_rate * 100).toFixed(0)}% | ${(r.goal_rate * 100).toFixed(0)}% | ${r.mean_total_reward ?? '—'} |`);
  return L.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runInsights();
  console.log(`Insights for ${r.runs} runs → ${OUT}`);
}
