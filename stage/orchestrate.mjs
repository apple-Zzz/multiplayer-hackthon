#!/usr/bin/env node
// Runs one full performance with three independent agents (headless `claude -p` calls).
//
// Each turn: every agent privately bids (act/defer + urgency + 1–3 candidate actions with lines)
// from only what it can observe and its own private knowledge → one actor is selected →
// the learned policy picks among that actor's valid candidates → the action is applied and
// published to the live stage before the next round of bids. 15 turns, then the ending.
//
//   node stage/orchestrate.mjs --seed 101 [--mode baseline|train|learned|showcase] [--model sonnet] [--no-voices] [--no-bruin]
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  IDS, NAMES, TOTAL_TURNS, RESPONSE_SCHEMA, briefing, systemPrompt, freshState, hiddenFromSeed,
  validate, intentOf, selectActor, apply, resolve, snapshot,
} from './world.mjs';
import { loadPolicy, savePolicy, choose, update } from './policy.mjs';
import { renderLine } from './voices.mjs';
import { archiveRun } from './archive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_FILE = join(ROOT, 'performance', 'live.json');   // not under public/: the dev server reloads pages when public/ changes
const LIVE_VOICES = join(ROOT, 'performance', 'voices');

// ---------------------------------------------------------------- one agent call
function callAgent(who, prompt, model, attempt = 0) {
  return new Promise((resolveCall) => {
    const args = ['-p', '--model', model, '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '',
      '--output-format', 'json', '--json-schema', JSON.stringify(RESPONSE_SCHEMA), '--system-prompt', systemPrompt(who)];
    const p = spawn('claude', args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 150000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', async () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error || !j.structured_output) throw new Error(j.result || 'no structured output');
        resolveCall({ ok: true, bid: j.structured_output, cost: j.total_cost_usd ?? 0 });
      } catch (e) {
        if (attempt < 2) resolveCall(await callAgent(who, prompt, model, attempt + 1));
        else resolveCall({ ok: false, error: String(e.message || e).slice(0, 300) + (err ? ` | ${err.slice(0, 200)}` : ''), cost: 0 });
      }
    });
    p.stdin.end(prompt);
  });
}

/** Keep only candidates that are valid right now; tag each with its intent. */
function vetBid(s, who, bid) {
  const valid = [], rejected = [];
  for (const c of bid.candidates ?? []) {
    const why = validate(s, who, c.action);
    if (why) rejected.push({ action: c.action, why });
    else valid.push({ ...c, intent: intentOf(c.action, c) });
  }
  if (!valid.length) {
    const first = bid.candidates?.[0];
    valid.push({ action: { type: 'wait' }, line: first?.line ?? '', stage_direction: '', gesture: first?.gesture ?? 'none', intent: 'wait',
      plan: first?.plan ?? '', plan_changed: false, influenced_by_turn: null, reason: 'No valid action was proposed; holds position.' });
  }
  return { valid, rejected };
}

function publishLive(s, extra) {
  mkdirSync(dirname(LIVE_FILE), { recursive: true });
  writeFileSync(LIVE_FILE, JSON.stringify({
    status: s.ending ? 'ended' : 'running', names: NAMES, order: [], initial: snapshot(freshState(0)),
    turns: s.record, ending: s.ending, ...extra,
  }));
}

// ---------------------------------------------------------------- one full run
export async function runPerformance({ seed, mode = 'learned', model = 'sonnet', voices = true, bruin = true, live = true, log = console.log }) {
  // --batch: private voice folder, no live file, so several runs can go in parallel
  const VOICE_DIR = live ? LIVE_VOICES : join(tmpdir(), `third-survivor-voices-${seed}-${process.pid}`);
  const publish = live ? publishLive : () => {};
  const hidden = hiddenFromSeed(seed);
  const s = freshState(seed);
  const policy = loadPolicy(mode);
  const policyVersion = mode === 'baseline' ? 0 : policy.version;
  const bids = [], traces = [];
  let cost = 0;
  const started = new Date().toISOString();
  if (voices) { rmSync(VOICE_DIR, { recursive: true, force: true }); mkdirSync(VOICE_DIR, { recursive: true }); }
  publish(s, { mode, seed, hidden });
  log(`▶ seed ${seed} · mode ${mode} · model ${model} · policy v${policyVersion}`);

  while (s.turn < TOTAL_TURNS) {
    const turn = s.turn + 1;
    // 1) private bids, in parallel, each from that character's own view
    const calls = await Promise.all(IDS.map((who) => callAgent(who, briefing(s, who), model)));
    const round = {};
    IDS.forEach((who, i) => {
      const c = calls[i];
      cost += c.cost;
      const bid = c.ok ? c.bid : { want: 'defer', urgency: 0, candidates: [] };
      const { valid, rejected } = vetBid(s, who, bid);
      round[who] = { want: bid.want, urgency: bid.urgency ?? 0, bid_reason: bid.bid_reason ?? '', candidates: valid, rejected, error: c.ok ? null : c.error };
    });
    // 2) choose who acts (bids never become dialogue and are not turns)
    const sel = selectActor(s, round);
    // 3) the learned policy picks among that actor's valid candidates
    const pick = choose(policy, s, sel.who, round[sel.who].candidates, mode);
    traces.push({ turn, ...pick.trace });
    const cand = round[sel.who].candidates[pick.index];
    bids.push({ turn, selected: sel.who, how: sel.how, scores: sel.scores, policy: pick.trace,
      bids: Object.fromEntries(IDS.map((p) => [p, { want: round[p].want, urgency: round[p].urgency, bid_reason: round[p].bid_reason,
        candidates: round[p].candidates.map((c) => ({ action: c.action, intent: c.intent, line: c.line })), rejected: round[p].rejected, error: round[p].error }])) });
    // 4) apply, then voice + publish before the next round
    const entry = apply(s, hidden, sel.who, cand);
    entry.selected_by = sel.how.startsWith('everyone') ? 'all deferred' : sel.how.startsWith('tie') ? 'tie-break' : 'urgency';
    if (voices && entry.spoken_line) renderLine(VOICE_DIR, turn, sel.who, entry.spoken_line);
    publish(s, { mode, seed, hidden });
    log(`  ${String(turn).padStart(2)} ${NAMES[sel.who].padEnd(9)} ${entry.action.padEnd(18)} ${entry.spoken_line ? `“${entry.spoken_line}”` : '(silent)'}${pick.explored ? '  [explore]' : ''}`);
  }

  // 5) only now: survival, goals, rewards
  const ending = resolve(s, hidden);
  publish(s, { mode, seed, hidden });
  if (mode === 'train') savePolicy(update(policy, traces, ending.reward, `seed-${seed}`));
  const meta = { mode, seed, model, policy_version: policyVersion, policy_version_after: mode === 'train' ? policy.version : policyVersion,
    hidden, started, finished: new Date().toISOString(), cost_usd: +cost.toFixed(4), rules: 'v2' };
  const runId = archiveRun({ state: s, meta, bids, traces, bruin, voiceDir: VOICE_DIR, latest: live });
  publish(s, { mode, seed, hidden, run_id: runId });
  log(`■ ${runId}: ${IDS.map((p) => `${NAMES[p]} ${ending.status[p]}`).join(', ')} · $${meta.cost_usd}`);
  return { runId, ending, meta };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  await runPerformance({
    seed: Number(arg('seed', Date.now() % 100000)), mode: arg('mode', 'learned'), model: arg('model', 'sonnet'),
    voices: !process.argv.includes('--no-voices'), bruin: !process.argv.includes('--no-bruin') && !process.argv.includes('--batch'), live: !process.argv.includes('--batch'),
  });
}
