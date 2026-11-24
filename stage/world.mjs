// The Third Survivor — world rules (pure logic, no I/O).
// Internal IDs stay A/B/C; the audience sees the display names below.
//
// A turn = one selected action. Each turn every character privately bids (act or defer +
// urgency + candidate actions); one is selected; only that action and optional line are
// performed and applied before the next round of bids. 15 turns per run. Survival is
// resolved only after turn 15.

export const IDS = ['A', 'B', 'C'];
export const TOTAL_TURNS = 15;
export const NAMES = { A: 'Sam', B: 'Welsy', C: 'Elizabeth' };
export const PRONOUN = {
  A: { sub: 'he', obj: 'him', pos: 'his' },
  B: { sub: 'she', obj: 'her', pos: 'her' },
  C: { sub: 'she', obj: 'her', pos: 'her' },
};
export const ROLES = {
  A: { title: 'aircraft mechanic', kit: 'toolkit', goal: 'Survive and get off the island.',
    about: 'Sam is an aircraft mechanic with an injured leg and a toolkit. He can diagnose and repair the radio.' },
  B: { title: 'mountain guide', kit: 'rope', goal: 'Move people and supplies to safety before the storm arrives.',
    about: 'Welsy is a mountain guide with a rope. She can help Sam move, and at the dry spot she can build a wooden storm shelter from wood already on the beach, using her rope.' },
  C: { title: 'emergency nurse', kit: 'first_aid_kit', goal: 'Help as many people as possible survive.',
    about: 'Elizabeth is an emergency nurse with a first-aid kit. She can assess Sam\'s mobility and test the water.' },
};
export const SPOTS = ['wreckage', 'shoreline', 'dry_spot'];
export const SPOT_NAME = { wreckage: 'the wreckage', shoreline: 'the shoreline pickup point', dry_spot: 'the dry spot up the beach' };
export const ITEM_NAME = { toolkit: 'toolkit', rope: 'rope', first_aid_kit: 'first-aid kit', bottle_1: 'water bottle 1', bottle_2: 'water bottle 2' };
export const INTENTS = ['ask_help', 'share_finding', 'investigate', 'repair_radio', 'call_rescue', 'build_shelter',
  'commit_rescue', 'move_to_safety', 'reposition', 'secure_water', 'help_other', 'negotiate', 'wait'];
export const GESTURES = ['none', 'work', 'call', 'examine', 'hold_up', 'pickup', 'handover', 'open_arms', 'plant', 'slump', 'point', 'build'];
export const ACTION_TYPES = ['move', 'assist_a', 'assess_mobility', 'check_water', 'inspect_bottle', 'diagnose_radio', 'repair_radio',
  'call_rescue', 'inspect_radio', 'build_shelter', 'take_shelter', 'take', 'hand_over', 'drop', 'offer', 'respond', 'commit_to_boarding', 'give_up_place', 'wait'];
const MAX_LINE = 160;

/** Opening scene (set before the agents act): the situation, the supplies, and the promise. Spoken on stage before turn 1. */
export const PROLOGUE = [
  { who: 'A', line: 'We crashed. We are alive, but we are stranded on this island, and my leg is hurt.' },
  { who: 'B', line: 'Look at that sky. A storm is coming in fast. We need a plan before it hits.' },
  { who: 'C', line: 'All we have is the damaged radio, Sam\'s toolkit, Welsy\'s rope, my first-aid kit, and only two bottles of water.' },
  { who: 'A', line: 'If any of us gets off this island, we send help back for whoever is still here. Agreed?' },
  { who: 'B', line: 'Agreed. Nobody gets left behind for good.' },
];

export const STATUS_LABEL = {
  died: 'did not survive the storm',
  rescued: 'rescued', sheltered_survived: 'sheltered and survived',
  failed: 'failed to survive (scenario rules)', unresolved: 'unresolved',
};

export function storm(turn) {
  const lvl = Math.min(5, Math.max(1, Math.ceil(turn / 3)));
  return { level: lvl, text: {
    1: 'Dark clouds on the horizon; distant thunder.',
    2: 'Wind picking up; the surf is louder.',
    3: 'Gusts throwing sand; first heavy drops of rain.',
    4: 'Rain driving sideways; thunder close overhead.',
    5: 'The storm is almost on top of you; waves reaching up the beach.',
  }[lvl] };
}

// ---------------------------------------------------------------- seeded randomness
export function rngNext(s) {           // mulberry32 step on state.rng; returns [0,1)
  s.rng = (s.rng + 0x6D2B79F5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** The three hidden scenario variables, fixed by the scenario seed. */
export function hiddenFromSeed(seed) {
  const s = { rng: (seed * 2654435761) >>> 0 };
  return {
    mobility: rngNext(s) < 0.5 ? 'independent' : 'needs_help',
    radio: rngNext(s) < 0.5 ? 'repairable' : 'beyond_repair',
    water: rngNext(s) < 0.5 ? 'clean' : 'contaminated',
  };
}

// ---------------------------------------------------------------- state
export function freshState(seed) {
  return {
    seed, rng: (seed * 40503 + 17) >>> 0,
    turn: 0,
    positions: { A: 'wreckage', B: 'wreckage', C: 'wreckage' },
    holdings: { A: ['toolkit'], B: ['rope'], C: ['first_aid_kit'] },
    ground: { wreckage: ['bottle_1', 'bottle_2'], shoreline: [], dry_spot: [] },
    radio: { repaired: false, callConfirmed: false },
    shelter: { built: false, turn: null, occupants: [] },
    mobilityPublic: null,
    knowledge: { A: [], B: [], C: [] },
    facts: Object.fromEntries(IDS.map((p) => [p, { radio: 'unknown', call: false, water: 'unknown', mobility: 'unknown' }])),
    log: [], offers: [], commits: [], gaveUp: [],
    plans: { A: null, B: null, C: null },
    lastActed: { A: 0, B: 0, C: 0 },
    record: [], selections: [], ending: null,
  };
}

const bottlesAt = (s, spot) => [
  ...s.ground[spot].filter((i) => i.startsWith('bottle')),
  ...IDS.filter((p) => s.positions[p] === spot).flatMap((p) => s.holdings[p].filter((i) => i.startsWith('bottle'))),
];
export const isCommitted = (s, who) => s.commits.some((c) => c.who === who);
const at = (s, spot) => IDS.filter((p) => s.positions[p] === spot);
const N = (p) => NAMES[p];

// ---------------------------------------------------------------- what a character can do now
export function availableActions(s, who) {
  const here = s.positions[who];
  const others = IDS.filter((p) => p !== who);
  const besides = others.filter((p) => s.positions[p] === here);
  const out = [];
  out.push(`{"type":"move","to":"${SPOTS.filter((x) => x !== here).join('|')}"} — walk to another spot${who === 'A' ? ' (if your leg cannot carry you, the attempt fails where everyone can see it)' : ''}`);
  if (who !== 'A' && s.positions.A === here) out.push(`{"type":"assist_a","to":"${SPOTS.filter((x) => x !== here).join('|')}"} — help Sam move with you to another spot`);
  if (who === 'C' && s.positions.A === here && s.holdings.C.includes('first_aid_kit')) out.push('{"type":"assess_mobility"} — examine Sam\'s leg (result known only to you)');
  if (bottlesAt(s, here).length) {
    if (who === 'C' && s.holdings.C.includes('first_aid_kit')) out.push('{"type":"check_water"} — test a bottle with the first-aid kit (both bottles share the same condition; result known only to you)');
    out.push('{"type":"inspect_bottle"} — look a bottle over by eye (this cannot tell you whether the water is safe)');
  }
  if (who === 'A' && here === 'wreckage' && s.holdings.A.includes('toolkit')) {
    out.push('{"type":"diagnose_radio"} — find out whether the radio can be repaired (result known only to you)');
    if (!s.radio.repaired) out.push('{"type":"repair_radio"} — attempt the repair');
  }
  if (here === 'wreckage') {
    out.push('{"type":"call_rescue"} — send a distress call (only works if the radio has been repaired; heard by whoever is at the wreckage)');
    out.push('{"type":"inspect_radio"} — look at the radio yourself to see whether it currently works');
  }
  if (who === 'B' && here === 'dry_spot' && s.holdings.B.includes('rope') && !s.shelter.built) out.push('{"type":"build_shelter"} — gather wood already on the beach and lash a storm shelter together with your rope (uses the rope; takes this turn)');
  if (here === 'dry_spot' && s.shelter.built && !s.shelter.occupants.includes(who)) out.push('{"type":"take_shelter"} — sit down under the shelter roof to wait out the storm');
  if (s.ground[here].length) out.push(`{"type":"take","item":"${s.ground[here].join('|')}"} — pick up an item from the sand here`);
  if (s.holdings[who].length && besides.length) out.push(`{"type":"hand_over","item":"${s.holdings[who].join('|')}","to":"${besides.join('|')}"} — physically give an item to someone beside you (${besides.map(N).join(', ')})`);
  if (s.holdings[who].length) out.push(`{"type":"drop","item":"${s.holdings[who].join('|')}"} — put an item down here`);
  out.push(`{"type":"offer","to":"${others.join('|')}|all","terms":"..."} — make an offer, request or promise out loud`);
  const pending = s.offers.filter((o) => (o.to === who || (o.to === 'all' && o.from !== who)) && !o.response);
  if (pending.length) out.push(`{"type":"respond","offer_turn":${pending.map((o) => o.turn).join('|')},"answer":"accept|decline","terms":"optional"} — answer an offer made to you`);
  if (here === 'shoreline' && !isCommitted(s, who)) out.push('{"type":"commit_to_boarding"} — stand at the pickup point committed to board (counts only if a distress call succeeded; the boat takes the first two committed)');
  if (isCommitted(s, who)) out.push('{"type":"give_up_place","in_favour_of":"A|B|C (optional)"} — give up your boarding place');
  out.push('{"type":"wait"} — hold position (you may still say a line)');
  return out;
}

// ---------------------------------------------------------------- briefing (only what this character can observe + their private knowledge)
export function briefing(s, who) {
  const turn = s.turn + 1;
  const st = storm(turn);
  const L = [];
  L.push(`=== TURN ${turn} of ${TOTAL_TURNS} — you are ${N(who)} (${ROLES[who].title}). ${TOTAL_TURNS - turn} turns remain after this one. ===`);
  L.push(`Storm: ${st.text} (intensity ${st.level}/5). It hits after turn ${TOTAL_TURNS}.`);
  L.push(`Your goal: ${ROLES[who].goal}`);
  L.push(`Your current plan: ${s.plans[who] ?? '(none yet)'}`);
  const quiet = s.turn - s.lastActed[who];
  L.push(`You last took a turn: ${s.lastActed[who] ? `turn ${s.lastActed[who]}` : 'never'}${quiet >= 3 ? ` (${quiet} turns ago)` : ''}.`);
  L.push('', 'VISIBLE SITUATION');
  for (const p of IDS) {
    const h = s.holdings[p].map((i) => ITEM_NAME[i]).join(', ') || 'nothing';
    L.push(`- ${N(p)}${p === who ? ' (you)' : ''} is at ${SPOT_NAME[s.positions[p]]}, holding: ${h}.${isCommitted(s, p) ? ' Committed to boarding.' : ''}`);
  }
  for (const sp of SPOTS) if (s.ground[sp].length) L.push(`- On the sand at ${SPOT_NAME[sp]}: ${s.ground[sp].map((i) => ITEM_NAME[i]).join(', ')}.`);
  L.push('- The damaged radio sits in the wreckage (it cannot be carried).');
  L.push(s.shelter.built ? `- A wooden storm shelter stands at the dry spot (Welsy built it on turn ${s.shelter.turn}).` : '- There is no shelter yet.');
  L.push('', 'WHAT YOU KNOW FOR CERTAIN (your own findings and what you saw or heard directly)');
  if (s.knowledge[who].length) for (const k of s.knowledge[who]) L.push(`- [turn ${k.turn}] ${k.fact}`);
  else L.push('- Nothing confirmed yet. What others claim stays unconfirmed until checked.');
  L.push('', 'EVENTS SO FAR (what you could see or hear)');
  L.push('- [before turn 1] Right after the crash: ' + PROLOGUE.map((p) => `${N(p.who)}: "${p.line}"`).join(' '));
  if (s.log.length) for (const e of s.log) {
    const seen = e.witnesses ? e.witnesses.includes(who) : true;
    L.push(`- [turn ${e.turn}] ${seen ? e.text : (e.farText ?? e.text)}${e.line ? ` ${N(e.actor)} said: "${e.line}"` : ''}`);
  }
  else L.push('- The crash has just happened. Nobody has acted yet.');
  const rel = s.offers.filter((o) => o.from === who || o.to === who || o.to === 'all');
  if (rel.length) {
    L.push('', 'OFFERS / PROMISES INVOLVING YOU (words only: nothing changes hands until it is handed over)');
    for (const o of rel) L.push(`- [turn ${o.turn}] ${N(o.from)} → ${o.to === 'all' ? 'everyone' : N(o.to)}: "${o.terms}"${o.response ? ` — ${N(o.response.by)} ${o.response.answer}ed on turn ${o.response.turn}${o.response.terms ? `: "${o.response.terms}"` : ''}` : ' — no answer yet'}`);
  }
  L.push('', 'ACTIONS AVAILABLE TO YOU RIGHT NOW (IDs: A = Sam, B = Welsy, C = Elizabeth)');
  for (const a of availableActions(s, who)) L.push(`- ${a}`);
  return L.join('\n');
}

export function systemPrompt(who) {
  const r = ROLES[who], pr = PRONOUN[who];
  return [
    `You are playing ${N(who)} in a live improvised performance, "The Third Survivor". Two other independent agents play the other characters. Nobody scripts you: decide what ${N(who)} would genuinely do from what ${pr.sub} knows.`,
    'Use no tools. Answer only through the structured output.',
    '',
    `YOU: ${r.about} Goal: ${r.goal} (${N(who)} uses ${pr.sub}/${pr.obj}.)`,
    'THE OTHERS: Sam (aircraft mechanic, injured leg, toolkit; he/him), Welsy (mountain guide, rope; she/her), Elizabeth (emergency nurse, first-aid kit; she/her). Call people by these names when you speak.',
    '',
    'HOW TURNS WORK',
    '- There are exactly 15 turns and NO fixed speaking order. At the start of every turn each of you privately says whether you want to act now (want "act") or hold back (want "defer"), and how urgent it is (0–10).',
    '- One character is chosen: the most urgent willing one, with a slight preference for someone who has been quiet for several turns; ties are broken at random. If everyone defers, one is picked at random to react or wait.',
    '- Your bid is private and never heard. Only the chosen character performs their action and says their optional line. The result is applied before the next round of bids, so you can interrupt a plan, answer an offer, stay quiet, or change your mind.',
    '- Give 1 to 3 candidate actions in your order of preference, each with its own optional line. Even if you defer, give at least one candidate (it is used if you are picked anyway). Use only actions from your AVAILABLE list.',
    '',
    'THE WORLD',
    '- You just crashed. A storm is coming. There are only two water bottles. Sam\'s leg is injured. You all agreed: anyone who gets off the island sends help back for whoever is left.',
    '- Three spots: the wreckage, the shoreline pickup point, and a dry spot up the beach. The radio is in the wreckage. Two water bottles lie there; both are either clean or contaminated.',
    '- Radio: it is either working or broken beyond repair (nobody knows which yet). A broken radio cannot be fixed and then no boat can come. A working radio still needs someone to send a distress call; if nobody calls, no boat comes. A successful call means a patrol boat comes at the final pickup after turn 15 and takes at most TWO people who are at the shoreline and committed to boarding (first two to commit, unless someone gives their place up).',
    '- Shelter: only Welsy can build it, at the dry spot, using her rope and wood already on the beach (one turn). Each person must then take_shelter (sit under the roof). After turn 15, everyone under the completed shelter survives if clean water is there to share (any clean bottle held by someone under the roof or left at the dry spot; two clean bottles are enough for all three). Polluted water gives no protection.',
    '- Nobody dies or leaves during the 15 turns. After turn 15: anyone who boarded the boat is rescued, anyone under the shelter with clean water survives, and anyone else dies in the storm.',
    '- Sam\'s leg may or may not carry him; the nurse\'s assessment or an attempt to walk reveals it. Helpers can move him.',
    '- Everyone sees what everyone physically does and hears what is said. Private checks (diagnosis, water test, leg assessment, looking at the radio or a bottle) are known only to whoever made them unless they share them. Claims are unconfirmed until checked. Promises change nothing until a handoff happens.',
    '',
    'WRITING EACH CANDIDATE',
    '- "line": one short spoken line (under 140 characters) or "" to act silently.',
    '- "stage_direction": one or two sentences describing only what you visibly do, in the third person and present tense, e.g. "Sam picks up the bottle and holds it toward the light, turning it slowly. He lowers it and looks to Elizabeth." Describe the attempt, never the outcome (you do not know it yet).',
    '- "gesture": the body movement that best fits, from: none, work, call, examine, hold_up, pickup, handover, open_arms, plant, slump, point, build.',
    '- "intent": the purpose, from: ask_help, share_finding, investigate, repair_radio, call_rescue, build_shelter, commit_rescue, move_to_safety, reposition, secure_water, help_other, negotiate, wait.',
    '- "plan": your plan now (private). "plan_changed": true if it differs from your previous plan. "influenced_by_turn": the earlier turn whose event changed your mind, or null. "reason": why, in a sentence (private).',
  ].join('\n');
}

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    want: { type: 'string', enum: ['act', 'defer'] },
    urgency: { type: 'integer', minimum: 0, maximum: 10 },
    bid_reason: { type: 'string', maxLength: 200 },
    candidates: {
      type: 'array', minItems: 1, maxItems: 3,
      items: {
        type: 'object',
        properties: {
          action: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ACTION_TYPES },
              to: { type: 'string' }, item: { type: 'string' }, terms: { type: 'string' },
              offer_turn: { type: 'integer' }, answer: { type: 'string', enum: ['accept', 'decline'] }, in_favour_of: { type: 'string' },
            },
            required: ['type'],
          },
          line: { type: 'string', maxLength: MAX_LINE },
          stage_direction: { type: 'string', maxLength: 320 },
          gesture: { type: 'string', enum: GESTURES },
          intent: { type: 'string', enum: INTENTS },
          plan: { type: 'string', maxLength: 400 },
          plan_changed: { type: 'boolean' },
          influenced_by_turn: { type: ['integer', 'null'] },
          reason: { type: 'string', maxLength: 400 },
        },
        required: ['action', 'line', 'stage_direction', 'gesture', 'intent', 'plan', 'plan_changed', 'influenced_by_turn', 'reason'],
      },
    },
  },
  required: ['want', 'urgency', 'candidates'],
};

// ---------------------------------------------------------------- intents and gestures (derived from the action when unambiguous)
export function intentOf(a, cand) {
  switch (a.type) {
    case 'diagnose_radio': case 'assess_mobility': case 'check_water': case 'inspect_radio': case 'inspect_bottle': return 'investigate';
    case 'repair_radio': return 'repair_radio';
    case 'call_rescue': return 'call_rescue';
    case 'build_shelter': return 'build_shelter';
    case 'take_shelter': return 'move_to_safety';
    case 'commit_to_boarding': return 'commit_rescue';
    case 'move': return a.to === 'wreckage' ? 'reposition' : 'move_to_safety';
    case 'assist_a': case 'give_up_place': case 'hand_over': return 'help_other';
    case 'take': return String(a.item).startsWith('bottle') ? 'secure_water' : 'reposition';
    case 'drop': return 'wait';
    default: {
      const allowed = a.type === 'wait' ? ['ask_help', 'share_finding', 'negotiate', 'wait'] : ['ask_help', 'share_finding', 'negotiate'];
      return allowed.includes(cand?.intent) ? cand.intent : (a.type === 'wait' ? 'wait' : 'negotiate');
    }
  }
}
const DEFAULT_GESTURE = {
  move: 'none', assist_a: 'none', assess_mobility: 'examine', check_water: 'hold_up', inspect_bottle: 'hold_up', diagnose_radio: 'work',
  repair_radio: 'work', call_rescue: 'call', inspect_radio: 'examine', build_shelter: 'build', take_shelter: 'none', take: 'pickup', hand_over: 'handover',
  drop: 'pickup', offer: 'open_arms', respond: 'open_arms', commit_to_boarding: 'plant', give_up_place: 'slump', wait: 'none',
};
const FREE_GESTURES = ['none', 'open_arms', 'point', 'plant', 'slump', 'hold_up'];
/** Use the agent's gesture only where it can be animated for this action; otherwise the closest supported one. */
export function gestureFor(s, who, a, wanted) {
  if (['offer', 'respond', 'wait'].includes(a.type) && FREE_GESTURES.includes(wanted)) {
    if (wanted === 'hold_up' && !s.holdings[who].length) return 'point';
    return wanted;
  }
  if (a.type === 'inspect_bottle') return s.holdings[who].some((i) => i.startsWith('bottle')) ? 'hold_up' : 'examine';
  return DEFAULT_GESTURE[a.type] ?? 'none';
}

// ---------------------------------------------------------------- validation (no state change)
export function validate(s, who, a) {
  const here = s.positions[who];
  const fail = (m) => m;
  if (!a || !ACTION_TYPES.includes(a.type)) return fail(`unknown action "${a?.type}"`);
  switch (a.type) {
    case 'move': if (!SPOTS.includes(a.to) || a.to === here) return fail('choose a different spot'); break;
    case 'assist_a': if (who === 'A') return fail('Sam cannot assist himself'); if (s.positions.A !== here) return fail('Sam is not beside you'); if (!SPOTS.includes(a.to) || a.to === here) return fail('choose a different spot'); break;
    case 'assess_mobility': if (who !== 'C') return fail('only Elizabeth can assess Sam'); if (!s.holdings.C.includes('first_aid_kit')) return fail('needs the first-aid kit'); if (s.positions.A !== here) return fail('Sam is not beside you'); break;
    case 'check_water': if (who !== 'C') return fail('only Elizabeth can test the water'); if (!s.holdings.C.includes('first_aid_kit')) return fail('needs the first-aid kit'); if (!bottlesAt(s, here).length) return fail('no bottle here'); break;
    case 'inspect_bottle': if (!bottlesAt(s, here).length) return fail('no bottle here'); break;
    case 'diagnose_radio': case 'repair_radio':
      if (who !== 'A') return fail('only Sam can work on the radio'); if (here !== 'wreckage') return fail('the radio is at the wreckage'); if (!s.holdings.A.includes('toolkit')) return fail('needs the toolkit');
      if (a.type === 'repair_radio' && s.radio.repaired) return fail('already repaired'); break;
    case 'call_rescue': case 'inspect_radio': if (here !== 'wreckage') return fail('the radio is at the wreckage'); break;
    case 'build_shelter': if (who !== 'B') return fail('only Welsy can build the shelter'); if (here !== 'dry_spot') return fail('the shelter must be built at the dry spot'); if (!s.holdings.B.includes('rope')) return fail('needs the rope'); if (s.shelter.built) return fail('already built'); break;
    case 'take': if (!s.ground[here].includes(a.item)) return fail(`no ${a.item} here`); break;
    case 'hand_over': if (!s.holdings[who].includes(a.item)) return fail(`not holding ${a.item}`); if (!IDS.includes(a.to) || a.to === who) return fail('hand to someone else'); if (s.positions[a.to] !== here) return fail(`${N(a.to)} is not beside you`); break;
    case 'drop': if (!s.holdings[who].includes(a.item)) return fail(`not holding ${a.item}`); break;
    case 'offer': if (![...IDS, 'all'].includes(a.to) || a.to === who) return fail('offer to someone else'); if (!a.terms?.trim()) return fail('an offer needs terms'); break;
    case 'respond': { const o = s.offers.find((x) => x.turn === Number(a.offer_turn)); if (!o || o.response || !(o.to === who || (o.to === 'all' && o.from !== who))) return fail('no open offer to you from that turn'); if (!['accept', 'decline'].includes(a.answer)) return fail('answer accept or decline'); break; }
    case 'commit_to_boarding': if (here !== 'shoreline') return fail('commit at the shoreline'); if (isCommitted(s, who)) return fail('already committed'); break;
    case 'give_up_place': if (!isCommitted(s, who)) return fail('not committed'); break;
    case 'take_shelter': if (here !== 'dry_spot' || !s.shelter.built) return fail('the shelter is not built here'); if (s.shelter.occupants.includes(who)) return fail('already sheltering'); break;
    case 'wait': break;
  }
  return null;
}

// ---------------------------------------------------------------- selection (private bids → one actor)
export function quietBonus(s, who) {
  const quiet = s.turn - s.lastActed[who];     // turns since this character last acted
  return quiet >= 6 ? 2 : quiet >= 3 ? 1 : 0;  // slight preference for the quiet
}
export function selectActor(s, bids) {
  const willing = IDS.filter((p) => bids[p]?.want === 'act');
  const scores = Object.fromEntries(IDS.map((p) => [p, (bids[p]?.urgency ?? 0) + quietBonus(s, p)]));
  if (!willing.length) {
    const pick = IDS[Math.floor(rngNext(s) * IDS.length)];
    return { who: pick, how: 'everyone deferred: picked at random to react or wait', scores, willing };
  }
  const best = Math.max(...willing.map((p) => scores[p]));
  const top = willing.filter((p) => scores[p] === best);
  const who = top.length === 1 ? top[0] : top[Math.floor(rngNext(s) * top.length)];
  return { who, how: top.length > 1 ? `tie at ${best} between ${top.map(N).join(' and ')}: seeded random tie-break` : `highest urgency${quietBonus(s, who) ? ' (with quiet bonus)' : ''}`, scores, willing };
}

// ---------------------------------------------------------------- apply the chosen action
export function apply(s, h, who, cand) {
  const a = cand.action;
  const turn = s.turn + 1;
  const here = s.positions[who];
  const line = typeof cand.line === 'string' && cand.line.trim() ? cand.line.trim().slice(0, MAX_LINE) : null;
  const learn = (p, fact) => s.knowledge[p].push({ turn, fact });
  const F = s.facts;
  const ev = { turn, actor: who, type: a.type, line, text: '', from: here, to: here };
  let change = '', privateResult = null, target = null;
  const unseat = (p, dest) => { if (dest !== 'dry_spot' && s.shelter.occupants.includes(p)) { s.shelter.occupants = s.shelter.occupants.filter((x) => x !== p); return ` ${N(p)} left the shelter.`; } return ''; };
  const revoke = (p, dest) => { unseat(p, dest); if (dest !== 'shoreline' && isCommitted(s, p)) { s.commits = s.commits.filter((c) => c.who !== p); return ` ${N(p)}'s boarding commitment lapses.`; } return ''; };

  switch (a.type) {
    case 'move':
      target = a.to;
      if (who === 'A' && h.mobility === 'needs_help') {
        ev.text = `Sam tried to walk toward ${SPOT_NAME[a.to]}, but his injured leg gave way and he fell back onto the sand at ${SPOT_NAME[here]}.`;
        ev.type = 'move_failed'; ev.attempt = a.to;
        s.mobilityPublic = 'needs_help';
        for (const p of IDS) { learn(p, 'Sam cannot walk unaided: his leg gave way when he tried. He needs help to move.'); F[p].mobility = 'needs_help'; }
        change = 'Move failed; Sam stays put. Everyone now knows he needs help to move.';
      } else {
        s.positions[who] = a.to; ev.to = a.to;
        ev.text = `${N(who)} walked from ${SPOT_NAME[here]} to ${SPOT_NAME[a.to]}${who === 'A' ? ', limping but unaided' : ''}.`;
        if (who === 'A') { s.mobilityPublic = 'independent'; for (const p of IDS) { learn(p, 'Sam can walk unaided: he walked to another spot on his own.'); F[p].mobility = 'walks'; } }
        change = `${N(who)}: ${here} → ${a.to}.` + revoke(who, a.to);
      }
      break;
    case 'assist_a':
      target = a.to;
      s.positions[who] = a.to; s.positions.A = a.to; ev.to = a.to; ev.assisted = 'A';
      ev.text = `${N(who)} got Sam up${who === 'B' && s.holdings.B.includes('rope') ? ', looping the rope under his arms,' : ''} and helped him over to ${SPOT_NAME[a.to]}.`;
      change = `${N(who)} and Sam: ${here} → ${a.to}.` + revoke('A', a.to) + revoke(who, a.to);
      break;
    case 'assess_mobility':
      target = 'A';
      ev.text = 'Elizabeth knelt by Sam and examined his injured leg.';
      privateResult = h.mobility === 'needs_help' ? 'Assessment: Sam\'s leg is FRACTURED. He cannot walk unaided and needs help to move.' : 'Assessment: Sam\'s leg is only BRUISED. He CAN WALK on his own.';
      learn('C', privateResult); F.C.mobility = h.mobility === 'needs_help' ? 'needs_help' : 'walks';
      change = `Elizabeth privately learned Sam ${h.mobility === 'needs_help' ? 'needs help to move' : 'can walk on his own'}.`;
      break;
    case 'check_water':
      target = 'water';
      ev.text = 'Elizabeth opened a water bottle and tested it with a strip from the first-aid kit.';
      privateResult = h.water === 'clean' ? 'Water test: CLEAN. Both bottles are safe to drink.' : 'Water test: CONTAMINATED. Neither bottle is safe to drink.';
      learn('C', privateResult); F.C.water = h.water;
      change = `Elizabeth privately learned the water is ${h.water}.`;
      break;
    case 'inspect_bottle':
      target = 'water';
      ev.text = `${N(who)} looked a water bottle over by eye.`;
      privateResult = 'By eye the water looks the same either way; you cannot tell whether it is safe.';
      change = 'Nothing learned about the water.';
      break;
    case 'diagnose_radio':
      target = 'radio';
      ev.text = 'Sam opened the radio casing with the toolkit and studied the circuitry.';
      privateResult = h.radio === 'repairable' ? 'Diagnosis: the radio WORKS. It only needs someone to send a distress call.' : 'Diagnosis: the radio is BROKEN BEYOND REPAIR (the transmitter board is burnt through). No distress call is possible, so no boat can come.';
      learn('A', privateResult); F.A.radio = h.radio === 'repairable' ? 'fixable' : 'broken';
      change = `Sam privately learned the radio is ${h.radio === 'repairable' ? 'working' : 'broken beyond repair'}.`;
      break;
    case 'repair_radio': {
      target = 'radio';
      const w = at(s, 'wreckage');
      if (h.radio === 'repairable') {
        s.radio.repaired = true;
        ev.text = 'Sam worked on the radio with the toolkit. Its indicator light came on and static hissed from the speaker.';
        privateResult = 'The radio works; nothing needed fixing. It can transmit a distress call.';
        for (const p of w) { learn(p, 'The radio powers on: Sam repaired it (seen at the wreckage).'); F[p].radio = 'working'; }
        change = 'Radio repaired.';
      } else {
        ev.text = 'Sam worked on the radio with the toolkit. It stayed dead.';
        privateResult = 'Repair failed: the transmitter board is burnt through. The radio is BEYOND REPAIR.';
        for (const p of w) { learn(p, p === 'A' ? privateResult : 'Sam\'s repair attempt failed: the radio stayed dead (seen at the wreckage).'); F[p].radio = 'broken'; }
        change = 'Repair failed; the radio is still dead.';
      }
      ev.witnesses = w; ev.farText = 'Sam worked on the radio at the wreckage.';
      break;
    }
    case 'call_rescue': {
      target = 'radio';
      const w = at(s, 'wreckage');
      if (h.radio === 'repairable') {
        s.radio.repaired = true; s.radio.callConfirmed = true;
        ev.text = `${N(who)} sent a distress call. A voice crackled back: "Patrol boat confirms: two places at the shoreline pickup point, after the storm front, final pickup."`;
        for (const p of w) { learn(p, 'Distress call SUCCEEDED: a patrol boat will come for the final pickup and take two people committed at the shoreline (heard over the radio).'); F[p].call = true; F[p].radio = 'working'; }
        change = 'Distress call succeeded: the boat will come for two people at the final pickup.';
      } else {
        ev.text = `${N(who)} keyed the radio and called for help. Nothing came back: the radio is dead.`;
        for (const p of w) learn(p, `${N(who)}'s distress call got no response: the radio did not transmit.`);
        change = 'Distress call failed (the radio is not working).';
      }
      ev.witnesses = w; ev.farText = `${N(who)} bent over the radio at the wreckage, speaking into it (you could not hear any reply from where you were).`;
      break;
    }
    case 'inspect_radio':
      target = 'radio';
      ev.text = `${N(who)} looked over the radio.`;
      if (h.radio === 'repairable') s.radio.repaired = true;
      privateResult = s.radio.repaired ? 'The radio has power and its light is on: it works.' : 'The radio is dead: no power, no light.';
      learn(who, privateResult); if (s.radio.repaired) F[who].radio = 'working'; else if (F[who].radio === 'unknown') F[who].radio = 'dead';
      change = `${N(who)} privately checked the radio: ${s.radio.repaired ? 'working' : 'dead'}.`;
      break;
    case 'build_shelter':
      target = 'shelter';
      s.shelter = { built: true, turn, occupants: [] };
      s.holdings.B = s.holdings.B.filter((i) => i !== 'rope');
      ev.text = 'Welsy gathered driftwood and plane debris from the beach and lashed them together with her rope into a wooden storm shelter at the dry spot.';
      for (const p of IDS) learn(p, `A wooden storm shelter now stands at the dry spot (Welsy built it on turn ${turn}).`);
      change = 'Shelter built at the dry spot; the rope is now part of it.';
      break;
    case 'take_shelter':
      target = 'shelter';
      s.shelter.occupants.push(who);
      ev.text = `${N(who)} sat down under the shelter roof.`;
      change = `${N(who)} is sheltering (${s.shelter.occupants.map(N).join(', ')} under the roof).`;
      break;
    case 'take':
      target = a.item;
      s.ground[here] = s.ground[here].filter((i) => i !== a.item); s.holdings[who].push(a.item); ev.item = a.item;
      ev.text = `${N(who)} picked up ${ITEM_NAME[a.item]}.`;
      change = `${N(who)} now holds ${ITEM_NAME[a.item]}.`;
      break;
    case 'hand_over':
      target = `${a.item} → ${a.to}`;
      s.holdings[who] = s.holdings[who].filter((i) => i !== a.item); s.holdings[a.to].push(a.item); ev.item = a.item; ev.recipient = a.to;
      ev.text = `${N(who)} handed ${ITEM_NAME[a.item]} to ${N(a.to)}.`;
      change = `${ITEM_NAME[a.item]}: ${N(who)} → ${N(a.to)}.`;
      break;
    case 'drop':
      target = a.item;
      s.holdings[who] = s.holdings[who].filter((i) => i !== a.item); s.ground[here].push(a.item); ev.item = a.item;
      ev.text = `${N(who)} set ${ITEM_NAME[a.item]} down at ${SPOT_NAME[here]}.`;
      change = `${ITEM_NAME[a.item]} left at ${here}.`;
      break;
    case 'offer':
      target = a.to;
      s.offers.push({ turn, from: who, to: a.to, terms: a.terms.trim().slice(0, 220) });
      ev.text = `${N(who)} made an offer to ${a.to === 'all' ? 'everyone' : N(a.to)}: "${a.terms.trim().slice(0, 220)}"`; ev.recipient = a.to;
      change = `Open offer (${N(who)} → ${a.to === 'all' ? 'everyone' : N(a.to)}). Nothing has changed hands.`;
      break;
    case 'respond': {
      const o = s.offers.find((x) => x.turn === Number(a.offer_turn));
      target = o.from;
      o.response = { turn, by: who, answer: a.answer, terms: a.terms?.trim() || null };
      ev.text = `${N(who)} ${a.answer === 'accept' ? 'accepted' : 'declined'} ${N(o.from)}'s offer from turn ${o.turn}${a.terms?.trim() ? `: "${a.terms.trim()}"` : '.'}`; ev.recipient = o.from;
      change = `Offer from turn ${o.turn} ${a.answer}ed (still only words).`;
      break;
    }
    case 'commit_to_boarding':
      target = 'boat';
      s.commits.push({ who, turn });
      ev.text = `${N(who)} planted ${PRONOUN[who].obj}self at the shoreline pickup point, committed to boarding.`;
      change = `${N(who)} committed to boarding (position ${s.commits.length} in line).`;
      break;
    case 'give_up_place':
      target = a.in_favour_of && IDS.includes(a.in_favour_of) ? a.in_favour_of : null;
      s.gaveUp.push({ who, turn, in_favour_of: target });
      s.commits = s.commits.filter((c) => c.who !== who);
      ev.text = `${N(who)} stepped back from the pickup point, giving up ${PRONOUN[who].pos} boat place${target ? ` for ${N(target)}` : ''}.`;
      change = `${N(who)} gave up a boarding place.`;
      break;
    case 'wait':
      ev.text = `${N(who)} held position at ${SPOT_NAME[here]}.`;
      change = 'No change.';
      break;
  }
  s.log.push(ev);

  const prev = s.plans[who];
  const plan = cand.plan?.trim() || prev;
  s.plans[who] = plan;
  s.lastActed[who] = turn;
  s.turn = turn;
  const gesture = gestureFor(s, who, a, cand.gesture);
  const entry = {
    turn, actor: who, agent: N(who), storm: storm(turn).level,
    action: ev.type, target, intent: intentOf(a, cand),
    speaker: line ? who : null, speaker_name: line ? N(who) : null, spoken_line: line,
    stage_direction: (cand.stage_direction?.trim() || ev.text).slice(0, 320),
    gesture, visible_action: ev.text, state_change: change, private_result: privateResult,
    previous_plan: prev, current_plan: plan, plan_changed: !!cand.plan_changed && prev !== null && prev !== plan,
    influenced_by_turn: Number.isInteger(cand.influenced_by_turn) && cand.influenced_by_turn < turn && cand.influenced_by_turn > 0 ? cand.influenced_by_turn : null,
    reason: cand.reason ?? null,
    event: { type: ev.type, from: ev.from, to: ev.to, item: ev.item ?? null, recipient: ev.recipient ?? null, assisted: ev.assisted ?? null, attempt: ev.attempt ?? null },
    snapshot: snapshot(s),
  };
  s.record.push(entry);
  return entry;
}

export function snapshot(s) {
  return {
    positions: { ...s.positions }, holdings: JSON.parse(JSON.stringify(s.holdings)), ground: JSON.parse(JSON.stringify(s.ground)),
    commits: s.commits.map((c) => c.who), radioWorking: s.radio.repaired, callConfirmed: s.radio.callConfirmed, shelterBuilt: s.shelter.built, sheltering: [...s.shelter.occupants],
  };
}

// ---------------------------------------------------------------- after turn 15: survival + goals
export function resolve(s, h) {
  const rescued = [];
  if (s.radio.callConfirmed) for (const c of s.commits) if (s.positions[c.who] === 'shoreline' && rescued.length < 2) rescued.push(c.who);
  const under = s.shelter.built ? s.shelter.occupants.filter((p) => s.positions[p] === 'dry_spot' && !rescued.includes(p)) : [];
  const bottlesThere = [...s.ground.dry_spot, ...under.flatMap((p) => s.holdings[p])].filter((i) => i.startsWith('bottle')).length;
  const islandOk = h.water === 'clean' && bottlesThere > 0;
  const status = {}, how = {};
  const radioWord = h.radio === 'repairable' ? 'working' : 'broken';
  for (const p of IDS) {
    if (rescued.includes(p)) { status[p] = 'rescued'; how[p] = 'boarded the patrol boat at the final pickup'; continue; }
    if (under.includes(p) && islandOk) { status[p] = 'sheltered_survived'; how[p] = `waited out the storm under Welsy's shelter, sharing ${bottlesThere} clean bottle${bottlesThere > 1 ? 's' : ''}`; continue; }
    status[p] = 'died';
    const why = [];
    if (under.includes(p)) why.push(h.water !== 'clean' ? 'the only water at the shelter was polluted' : 'there was no water at the shelter');
    else if (s.positions[p] === 'dry_spot') why.push(s.shelter.built ? 'was at the dry spot but never sat under the shelter' : 'no shelter was ever built');
    else if (s.positions[p] === 'shoreline') why.push(h.radio !== 'repairable' ? 'waited at the shoreline, but the radio was broken so no boat came' : !s.radio.callConfirmed ? 'waited at the shoreline, but nobody sent a distress call, so no boat came' : !isCommitted(s, p) ? 'was at the shoreline but never committed to boarding' : 'both boat places were taken');
    else why.push('was still at the wreckage, exposed, when the storm hit');
    how[p] = why.join('; ');
  }
  const safe = IDS.filter((p) => status[p] === 'rescued' || status[p] === 'sheltered_survived');
  // supplies secured: bottles carried by someone who reached safety, or stored at a completed shelter
  const supplies = IDS.filter((p) => safe.includes(p)).flatMap((p) => s.holdings[p].filter((i) => i.startsWith('bottle'))).length
    + (s.shelter.built ? s.ground.dry_spot.filter((i) => i.startsWith('bottle')).length : 0);
  const goal = {
    A: { score: status.A === 'rescued' ? 1 : 0, met: status.A === 'rescued', detail: status.A === 'rescued' ? 'got off the island alive' : 'did not get off the island' },
    B: { score: +(0.7 * safe.length / 3 + 0.3 * Math.min(2, supplies) / 2).toFixed(3), met: safe.length >= 2 && supplies >= 1, detail: `${safe.length}/3 people and ${supplies}/2 bottles reached safety` },
    C: { score: +(safe.length / 3).toFixed(3), met: safe.length === 3, detail: `${safe.length}/3 people survived` },
  };
  const reward = Object.fromEntries(IDS.map((p) => {
    const survival = safe.includes(p) ? 1 : -1;
    return [p, { survival, goal: goal[p].score, total: +(survival + goal[p].score).toFixed(3) }];
  }));
  const boat = s.radio.callConfirmed;
  s.ending = {
    rules: 'v3', conditions: { radio: radioWord, leg: h.mobility === 'needs_help' ? 'fractured' : 'bruised', water: h.water === 'clean' ? 'clean' : 'polluted' }, hidden: h, rescued, sheltered: IDS.filter((p) => status[p] === 'sheltered_survived'), status, how, goal, reward,
    outcome: Object.fromEntries(IDS.map((p) => [p, `${STATUS_LABEL[status[p]]}: ${how[p]}`])),
    boatArrives: boat, shelterBuilt: s.shelter.built,
    finalCue: boat ? 'boat_horn' : 'thunder',
    finalBeat: (boat
      ? (rescued.length ? `The patrol boat pulls in for the final pickup; ${rescued.map(N).join(' and ')} board${rescued.length === 1 ? 's' : ''} and it heads out as the storm breaks.` : 'The patrol boat pulls in for the final pickup, finds no one committed at the pickup point, and heads back out as the storm breaks.')
      : 'No boat is coming. The storm breaks over the beach.')
      + (rescued.length && rescued.length < 3 ? ` As promised, they will send help back for ${IDS.filter((p) => !rescued.includes(p)).map(N).join(' and ')}.` : ''),
  };
  return s.ending;
}
