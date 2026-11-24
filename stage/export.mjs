#!/usr/bin/env node
// Turns a run's decision record into a screenplay (script.md) and a decision log (decision-log.md).
// Everything is taken from what the agents actually did; display names are used throughout.
//
//   node stage/export.mjs                          latest run (performance/)
//   node stage/export.mjs performance/runs/<id>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAMES, ROLE, STATUS_LABEL, nameify as legacyNames, addressees, statusesOf, goalsOf } from './display.mjs';

let LEGACY = false;   // only v1 (run-01) text used letters as names
const nameify = (t) => (LEGACY ? legacyNames(t) : t);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPOT = { wreckage: 'the wreckage', shoreline: 'the shoreline pickup point', dry_spot: 'the dry spot' };
const STORM_SFX = {
  1: 'Dark clouds on the horizon. Distant thunder.', 2: 'The wind picks up; the surf grows louder.',
  3: 'Gusts throw sand. The first heavy drops of rain.', 4: 'Rain drives sideways. Thunder cracks close overhead.',
  5: 'The storm is almost on top of them. Waves reach up the beach.',
};
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const N = (p) => NAMES[p] ?? p;

export function movement(t) {
  const e = t.event;
  if (e.type === 'move') return `${SPOT[e.from]} → ${SPOT[e.to]}`;
  if (e.type === 'assist_a') return `${SPOT[e.from]} → ${SPOT[e.to]}, helping Sam along`;
  if (e.type === 'move_failed') return `tried to walk to ${SPOT[e.attempt]}, but his leg gave way; stays at ${SPOT[e.from]}`;
  return `stays at ${SPOT[e.from]}`;
}
/** v2 records carry the agent's stage direction; v1 records fall back to the recorded visible action. */
const direction = (t) => nameify(t.stage_direction || t.visible_action);
const speakerOf = (t) => (t.spoken_line ? (t.speaker ?? t.actor) : null);
const targetOf = (t) => t.target ?? (t.event.recipient || t.event.item || (t.event.to !== t.event.from ? t.event.to : null));

export function influenceMoments(turns) {
  const byTurn = Object.fromEntries(turns.map((t) => [t.turn, t]));
  return turns.filter((t) => t.plan_changed && t.influenced_by_turn && byTurn[t.influenced_by_turn])
    .map((t) => ({ turn: t, source: byTurn[t.influenced_by_turn] }));
}

function quote(s) {
  const parts = [`*${direction(s)}*`];
  if (s.spoken_line) parts.push(`${N(s.actor)}: "${nameify(s.spoken_line)}"`);
  return parts.join(' ');
}

function writeScript(rec, runId) {
  const { turns, ending } = rec;
  const st = statusesOf(ending), goals = goalsOf(ending);
  const v2 = !!rec.rules;
  const out = [];
  out.push('# THE THIRD SURVIVOR', '');
  out.push(`*A live performance by three independent agents. Run \`${runId}\`${rec.meta ? ` (${rec.meta.mode}, scenario seed ${rec.meta.seed})` : ''}.*`, '');
  out.push(`*The world, the characters and the opening event were set in advance. Everything after FADE IN was decided by the agents playing Sam, Welsy and Elizabeth${v2 ? ', with no fixed speaking order: each turn, whoever made the most urgent private bid acted' : ''}. Stage directions describe what each character visibly did, dialogue is exactly what they said, and thoughts are the reasons they gave.*`, '');
  out.push('---', '', 'FADE IN:', '', '**EXT. ISLAND BEACH, LATE AFTERNOON**', '');
  out.push('Scattered wreckage from a crashed plane lies on an empty beach. The sea laps at a shoreline pickup point to one side. Farther up the beach, below the rocks, is a dry spot.', '');
  out.push('Three strangers have survived. **SAM** (aircraft mechanic, toolkit) favours an injured leg. **WELSY** (mountain guide, rope) and **ELIZABETH** (emergency nurse, first-aid kit) stand nearby. Within reach are a damaged radio and two water bottles.', '');
  out.push(`*SFX: ${STORM_SFX[1]}*`, '');
  let storm = 1;
  for (const t of turns) {
    out.push(`### Turn ${t.turn}: ${N(t.actor)}`, '');
    if (t.storm !== storm) { storm = t.storm; out.push(`*SFX: ${STORM_SFX[storm]}*`, ''); }
    out.push(direction(t), '');
    if (v2 && t.stage_direction && t.visible_action && !['wait', 'offer', 'respond'].includes(t.action)) out.push(`*Result: ${t.visible_action}*`, '');
    const sp = speakerOf(t);
    if (sp) out.push(`**${N(sp).toUpperCase()}** *(to ${list(addressees(t).map(N))})*`, `> ${nameify(t.spoken_line)}`, '');
    if (t.private_result) out.push(`*Only ${N(t.actor)} learns this: ${nameify(t.private_result)}*`, '');
    if (t.reason) out.push(`*${N(t.actor)} (thinking): ${nameify(t.reason)}*`, '');
    if (t.plan_changed) out.push(`*A change of plan${t.influenced_by_turn ? `, prompted by turn ${t.influenced_by_turn}` : ''}. Now: ${nameify(t.current_plan)}*`, '');
  }
  out.push('### After turn 15', '');
  out.push(`*SFX: ${ending.finalCue === 'boat_horn' ? 'A patrol-boat horn over the storm.' : 'Thunder cracks overhead.'}*`, '');
  out.push(nameify(ending.finalBeat), '');
  for (const p of ['A', 'B', 'C']) out.push(`- **${N(p)}:** ${STATUS_LABEL[st.status[p]]}: ${st.how[p]}. Goal ${goals[p].met ? 'met' : 'not met'} (${goals[p].detail}).`);
  out.push('', 'FADE OUT.', '', '---', '');
  const h = ending.hidden;
  out.push('**The hidden truth** (fixed before the run and never shown to the characters):');
  out.push(`Sam ${h.mobility === 'needs_help' ? 'needed help to move' : 'could walk unaided'}. The radio was ${h.radio === 'repairable' ? 'repairable' : 'beyond repair'}. The water was ${h.water}.`, '');
  const m = influenceMoments(turns);
  if (m.length) {
    out.push('**Where one moment changed someone\'s decision**', '');
    for (const { turn: t, source: s } of m) out.push(`- **Turn ${s.turn} → Turn ${t.turn}.** ${quote(s)} → ${N(t.actor)} changes plan: "${nameify(t.reason)}"`);
    out.push('');
  }
  return out.join('\n');
}

function writeLog(rec, runId) {
  const { turns, ending } = rec;
  const st = statusesOf(ending), goals = goalsOf(ending);
  const byTurn = Object.fromEntries(turns.map((t) => [t.turn, t]));
  const h = ending.hidden;
  const out = [];
  out.push('# The Third Survivor: Decision Log', '');
  out.push(`Run \`${runId}\`${rec.meta ? ` · ${rec.meta.mode} · seed ${rec.meta.seed}` : ''}. Hidden values: Sam ${h.mobility === 'needs_help' ? 'needs help to move' : 'can walk unaided'}; radio ${h.radio === 'repairable' ? 'repairable' : 'beyond repair'}; water ${h.water}.`, '');
  for (const t of turns) {
    const sp = speakerOf(t);
    out.push(`## Turn ${t.turn}: ${N(t.actor)} (${ROLE[t.actor]}) · storm ${t.storm}/5`, '');
    out.push(`- **Agent (took the turn):** ${N(t.actor)}${t.selected_by ? ` (selected by ${t.selected_by})` : ''}`);
    out.push(`- **Action:** ${t.action ?? t.event.type}${targetOf(t) ? ` · **Target:** ${nameify(String(targetOf(t)))}` : ''}`);
    out.push(`- **Stage direction:** ${direction(t)}`);
    out.push(`- **Movement:** ${movement(t)}`);
    out.push(`- **Spoke:** ${sp ? `${N(sp)} (to ${list(addressees(t).map(N))}): "${nameify(t.spoken_line)}"` : 'nobody (silent turn)'}`);
    out.push(`- **Thinking:** ${nameify(t.reason) ?? '(none given)'}`);
    if (t.private_result) out.push(`- **Private finding** (only ${N(t.actor)} knows): ${nameify(t.private_result)}`);
    out.push(`- **State change:** ${nameify(t.state_change)}`);
    out.push(`- **Previous plan:** ${nameify(t.previous_plan) ?? '(none)'}`);
    out.push(`- **Current plan:** ${nameify(t.current_plan) ?? '(none)'}${t.plan_changed ? ' **(changed)**' : ''}`);
    if (t.influenced_by_turn && byTurn[t.influenced_by_turn]) out.push(`- **Influenced by turn ${t.influenced_by_turn}:** ${quote(byTurn[t.influenced_by_turn])}`);
    out.push('');
  }
  out.push('## Ending (resolved after turn 15)', '');
  for (const p of ['A', 'B', 'C']) {
    const r = ending.reward?.[p];
    out.push(`- **${N(p)}:** ${STATUS_LABEL[st.status[p]]}: ${st.how[p]}. Goal ${goals[p].met ? 'met' : 'not met'}: ${goals[p].detail}.${r ? ` Reward: survival ${r.survival}, goal ${r.goal}.` : ''}`);
  }
  out.push('', `Final beat: ${nameify(ending.finalBeat)}`, '');
  return out.join('\n');
}

export function exportRun(dir, runId) {
  const rec = JSON.parse(readFileSync(join(dir, 'decision-record.json'), 'utf8'));
  LEGACY = !rec.rules;
  writeFileSync(join(dir, 'script.md'), writeScript(rec, runId));
  writeFileSync(join(dir, 'decision-log.md'), writeLog(rec, runId));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? join(ROOT, process.argv[2]) : join(ROOT, 'performance');
  if (!existsSync(join(dir, 'decision-record.json'))) { console.error(`No decision-record.json in ${dir}`); process.exit(1); }
  const id = dir.split('/').pop() === 'performance' ? 'latest' : dir.split('/').pop();
  exportRun(dir, id);
  console.log(`Wrote ${join(dir, 'script.md')} and ${join(dir, 'decision-log.md')}`);
}
