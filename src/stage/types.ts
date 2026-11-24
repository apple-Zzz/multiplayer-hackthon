// Schema of performance decision records (v1 = fixed-order run-01, v2 = bid-based runs) as written by stage/*.mjs.
import type { Who } from './rig';
export type { Who } from './rig';
export type Spot = 'wreckage' | 'shoreline' | 'dry_spot';
export type Status = 'rescued' | 'sheltered_survived' | 'died' | 'failed' | 'unresolved';

export interface Snapshot {
  positions: Record<Who, Spot>;
  holdings: Record<Who, string[]>;
  ground: Record<Spot, string[]>;
  commits: Who[];
  radioWorking: boolean;
  callConfirmed: boolean;
  shelterBuilt?: boolean;
  sheltering?: Who[];
}
export interface Turn {
  turn: number; actor: Who; storm: number;
  agent?: string; speaker?: Who | null; action?: string; target?: string | null; intent?: string;
  stage_direction?: string; gesture?: string; selected_by?: string;
  visible_action: string; spoken_line: string | null; state_change: string; private_result: string | null;
  previous_plan: string | null; current_plan: string | null; plan_changed: boolean;
  influenced_by_turn: number | null; reason: string | null;
  event: { type: string; from: Spot; to: Spot; item: string | null; recipient: string | null; assisted: string | null; attempt: Spot | null };
  snapshot: Snapshot;
}
export interface Ending {
  rules?: string;
  hidden: { mobility: string; radio: string; water: string };
  rescued: Who[]; sheltered: Who[]; outcome: Record<Who, string>;
  status?: Record<Who, Status>; how?: Record<Who, string>;
  goal?: Record<Who, { met: boolean; score: number; detail: string }>;
  reward?: Record<Who, { survival: number; goal: number; total: number }>;
  boatArrives?: boolean; shelterBuilt?: boolean;
  finalCue: 'boat_horn' | 'thunder'; finalBeat: string;
}
export interface PerformanceRecord {
  status?: 'running' | 'ended'; run_id?: string; rules?: string; meta?: { mode: string; seed: number };
  order: Who[]; turns: Turn[]; ending: Ending | null;
}

export const WHO: Who[] = ['A', 'B', 'C'];
export const NAMES: Record<Who, string> = { A: 'Sam', B: 'Welsy', C: 'Elizabeth' };
export const ROLE: Record<Who, string> = { A: 'Mechanic', B: 'Guide', C: 'Nurse' };
export const STATUS_LABEL: Record<Status, string> = {
  died: 'did not survive the storm',
  rescued: 'rescued', sheltered_survived: 'sheltered and survived', failed: 'failed to survive (scenario rules)', unresolved: 'unresolved',
};
export const INITIAL: Snapshot = {
  positions: { A: 'wreckage', B: 'wreckage', C: 'wreckage' },
  holdings: { A: ['toolkit'], B: ['rope'], C: ['first_aid_kit'] },
  ground: { wreckage: ['bottle_1', 'bottle_2'], shoreline: [], dry_spot: [] },
  commits: [], radioWorking: false, callConfirmed: false, shelterBuilt: false,
};

/** Legacy (run-01) text used the letters A/B/C as names; show display names instead. */
export const nameify = (text: string | null | undefined): string => (text ?? '').replace(/\b([ABC])\b(?! voice)/g, (_, l: Who) => NAMES[l]);

/** Text as the audience should see it: only legacy (v1) records need the letter→name mapping. */
export const displayText = (r: { rules?: string } | null | undefined, text: string | null | undefined): string =>
  r?.rules ? (text ?? '') : nameify(text);

/** Who a spoken line is addressed to: characters named in it, or everyone else. */
export function addresseesOf(t: Turn): Who[] {
  if (!t.spoken_line) return [];
  const others = WHO.filter((p) => p !== t.actor);
  if (/\b(both of you|everyone|all of you|we all)\b/i.test(t.spoken_line)) return others;
  const named = others.filter((p) => new RegExp(`\\b(${p}|${NAMES[p]})\\b`).test(t.spoken_line!));
  return named.length ? named : others;
}

/** Final status per character for either record format. */
export function statusOf(e: Ending): { status: Record<Who, Status>; how: Record<Who, string> } {
  if (e.status && e.how) return { status: e.status, how: e.how };
  const status = {} as Record<Who, Status>, how = {} as Record<Who, string>;
  for (const p of WHO) {
    if (e.rescued.includes(p)) { status[p] = 'rescued'; how[p] = 'boarded the patrol boat'; }
    else if (e.sheltered.includes(p)) { status[p] = 'sheltered_survived'; how[p] = 'waited out the storm at the dry spot with a clean bottle (v1 rules)'; }
    else { status[p] = 'unresolved'; how[p] = nameify(e.outcome[p]); }
  }
  return { status, how };
}
/** Did a boat come for the final pickup? (v2 says so explicitly; v1 = a call succeeded.) */
export const boatComes = (r: PerformanceRecord) =>
  r.ending?.boatArrives ?? !!r.turns[r.turns.length - 1]?.snapshot.callConfirmed;
