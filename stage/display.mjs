// What the audience sees: display names and text helpers shared by exports and reports.
export const NAMES = { A: 'Sam', B: 'Welsy', C: 'Elizabeth' };
export const ROLE = { A: 'aircraft mechanic', B: 'mountain guide', C: 'emergency nurse' };
export const STATUS_LABEL = { rescued: 'rescued', sheltered_survived: 'sheltered and survived', failed: 'failed to survive (scenario rules)', unresolved: 'unresolved' };
export const name = (id) => NAMES[id] ?? id;

/** Legacy (run-01) text used the letters A/B/C as names; show the display names instead. */
export function nameify(text) {
  if (!text) return text;
  return text.replace(/\b([ABC])\b(?! voice)/g, (_, l) => NAMES[l]);
}

/** Who a spoken line is addressed to: characters named in it, else everyone else. */
export function addressees(t) {
  if (!t.spoken_line) return [];
  const others = ['A', 'B', 'C'].filter((p) => p !== t.actor);
  if (/\b(both of you|everyone|all of you|we all)\b/i.test(t.spoken_line)) return others;
  const named = others.filter((p) => new RegExp(`\\b(${p}|${NAMES[p]})\\b`).test(t.spoken_line));
  return named.length ? named : others;
}

/** Normalise an ending from either record format into per-character status/how. */
export function statusesOf(ending) {
  if (!ending) return null;
  if (ending.status) return { status: ending.status, how: ending.how };
  const status = {}, how = {};
  for (const p of ['A', 'B', 'C']) {
    if (ending.rescued?.includes(p)) { status[p] = 'rescued'; how[p] = 'boarded the patrol boat'; }
    else if (ending.sheltered?.includes(p)) { status[p] = 'sheltered_survived'; how[p] = 'waited out the storm at the dry spot with a clean bottle (v1 rules: no shelter needed)'; }
    else { status[p] = 'unresolved'; how[p] = nameify(ending.outcome?.[p] ?? 'no secured path'); }
  }
  return { status, how };
}

/** Goal met per character (v2 records carry it; v1 derived with the same definitions). */
export function goalsOf(ending) {
  if (ending?.goal) return ending.goal;
  const { status } = statusesOf(ending);
  const safe = ['A', 'B', 'C'].filter((p) => status[p] === 'rescued' || status[p] === 'sheltered_survived').length;
  return {
    A: { met: status.A === 'rescued', score: status.A === 'rescued' ? 1 : 0, detail: status.A === 'rescued' ? 'got off the island alive' : 'did not get off the island' },
    B: { met: safe >= 2, score: +(0.7 * safe / 3 + 0.3).toFixed(3), detail: `${safe}/3 people reached safety` },
    C: { met: safe === 3, score: +(safe / 3).toFixed(3), detail: `${safe}/3 people survived` },
  };
}
