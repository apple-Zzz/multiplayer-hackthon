import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import './App.css';
import { Soundscape } from './sound';
import { loadRig, type Rig } from './stage/rig';
import { loadVoices, type Clip } from './stage/voice';
import { Performance, STAGE_H, STAGE_W, type Phase, type Scene, type Subtitle } from './stage/performance';
import { url } from './stage/url';
import { addresseesOf, displayText, NAMES, ROLE, STATUS_LABEL, statusOf, WHO, type PerformanceRecord, type Turn, type Who } from './stage/types';

const COLOR: Record<Who, string> = { A: '#e07a3f', B: '#3f8f5a', C: '#3f6fd0' };
const SPOT_SHORT: Record<string, string> = { wreckage: 'wreckage', shoreline: 'shoreline', dry_spot: 'dry spot' };

// Which record: ?run=<id> → performance/runs/<id>/, ?live → the orchestrator's live file, default → latest run.
const PARAMS = new URLSearchParams(window.location.search);
const RUN = PARAMS.get('run');
const LIVE = PARAMS.has('live');
const AUTOPLAY = PARAMS.has('autoplay');
const BASE = url(RUN ? `/performance/runs/${RUN}` : '/performance');
const RECORD_URL = LIVE ? url('/performance/live.json') : `${BASE}/decision-record.json`;
const VOICE_BASE = LIVE ? url('/performance/voices') : `${BASE}/voices`;

interface RunInfo { id: string; mode?: string; rules?: string; rescued: Who[]; sheltered: Who[]; status?: Record<Who, string> }
interface Insights {
  run_id: string;
  speaking: { agent: string; turns_taken: number; spoken_turns: number; spoken_words: number }[];
  most_spoken_by_turns: string; most_spoken_by_words: string;
  plan_changes: { turn: number; agent: string; reason: string; prompted_by_turn: number | null; prompted_by_agent: string | null; prompt_stage_direction: string | null; prompt_line: string | null }[];
  survival: { character: string; status_label: string; how: string; goal_met: boolean; goal_detail: string }[];
}
interface Aggregate {
  runs: { id: string; mode: string }[];
  speaking: { agent: string; runs: number; spoken_turns: number; spoken_words: number }[];
  training: { character: string; phase: string; runs: number; survival_rate: number; goal_rate: number; mean_survival_reward: number | null; mean_goal_reward: number | null }[];
}

function movementOf(t: Turn): string {
  const e = t.event;
  if (e.type === 'move') return `${SPOT_SHORT[e.from]} → ${SPOT_SHORT[e.to]}`;
  if (e.type === 'assist_a') return `${SPOT_SHORT[e.from]} → ${SPOT_SHORT[e.to]} (helping Sam)`;
  if (e.type === 'move_failed' && e.attempt) return `tried → ${SPOT_SHORT[e.attempt]}, leg gave way`;
  return `stays at ${SPOT_SHORT[e.from]}`;
}
const targetOf = (t: Turn) => t.target ?? (t.event.recipient || t.event.item || (t.event.to !== t.event.from ? t.event.to : null));
const loadImg = (src: string) => new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function App() {
  const [record, setRecord] = useState<PerformanceRecord | null>(null);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [turnIndex, setTurnIndex] = useState<number | null>(null);
  const [played, setPlayed] = useState(0);
  const [subtitle, setSubtitle] = useState<Subtitle | null>(null);
  const [caption, setCaption] = useState('');
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [tab, setTab] = useState<'log' | 'insights'>('log');
  const [insights, setInsights] = useState<Insights | null>(null);
  const [aggregate, setAggregate] = useState<Aggregate | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const sound = useRef(new Soundscape());
  const perf = useRef<Performance | null>(null);
  const assets = useRef<{ rig: Rig; bg: HTMLImageElement; scene: Scene; voices: Record<number, Clip>; prologue: { who: Who; line: string }[]; prologueClips: Record<number, Clip> } | null>(null);
  const decoder = useRef(new OfflineAudioContext(1, 1, 44100));

  // record (polled in live mode, with its voice clips reloaded as new lines arrive) + run list
  useEffect(() => {
    let alive = true, lastText = '';
    const tick = async () => {
      try {
        const r = await fetch(`${RECORD_URL}?t=${Date.now()}`);
        if (!r.ok) { if (alive && !lastText) setError(`Could not load ${RECORD_URL} (${r.status}).`); return; }
        const text = await r.text();
        if (!alive || text === lastText) return;
        lastText = text;
        const rec: PerformanceRecord = JSON.parse(text);
        if (LIVE && assets.current) { assets.current.voices = await loadVoices(decoder.current, VOICE_BASE); perf.current?.setVoices(assets.current.voices); }
        setRecord(rec);
      } catch (e) { if (alive && !lastText) setError(String(e)); }
    };
    tick();
    const id = LIVE ? setInterval(tick, 1500) : undefined;
    fetch(url(`/performance/runs/index.json?t=${Date.now()}`)).then((r) => (r.ok ? r.json() : [])).then((x) => alive && setRuns(x)).catch(() => {});
    return () => { alive = false; if (id) clearInterval(id); };
  }, []);

  // rig, background, scene sprites + dry-sand map, voices
  useEffect(() => {
    (async () => {
      try {
        const sceneJson = await (await fetch(url('/stage/scene.json'))).json();
        const [rig, bg, boat, shelter] = await Promise.all([loadRig(), loadImg(url('/stage/beach.jpg')), loadImg(url(sceneJson.sprites.boat.src)), loadImg(url(sceneJson.sprites.shelter.src))]);
        const voices = await loadVoices(decoder.current, VOICE_BASE);
        const prologue = await (await fetch(url('/stage/prologue/lines.json'))).json();
        const prologueClips = await loadVoices(decoder.current, url('/stage/prologue'));
        assets.current = { rig, bg, scene: { dry: sceneJson.dry, boat, shelter }, voices, prologue, prologueClips };
        setReady(true);
      } catch (e) { setError(`Could not load stage assets: ${e}`); }
    })();
  }, []);

  useEffect(() => {
    if (!ready || !record || !canvasRef.current) return;
    if (perf.current) { perf.current.setRecord(record); return; }
    const { rig, bg, scene, voices } = assets.current!;
    perf.current = new Performance(canvasRef.current.getContext('2d')!, rig, bg, scene, sound.current, {
      onPhase: setPhase,
      onTurn: (i) => { setTurnIndex(i); if (i !== null) setPlayed((p) => Math.max(p, i + 1)); },
      onSubtitle: setSubtitle,
      onCaption: setCaption,
    }, record, voices);
    perf.current.setPrologue(assets.current!.prologue, assets.current!.prologueClips);
    if (AUTOPLAY) { sound.current.start(); setStarted(true); setPlayed(0); perf.current.begin(); }
  }, [ready, record]);
  useEffect(() => () => perf.current?.stop(), []);

  // post-performance insights from Bruin
  const runId = record?.run_id ?? RUN ?? null;
  useEffect(() => {
    if (phase !== 'done' || !runId) return;
    fetch(url(`/performance/insights/runs/${runId}.json?t=${Date.now()}`)).then((r) => (r.ok ? r.json() : null)).then(setInsights).catch(() => {});
    fetch(url(`/performance/insights/aggregate.json?t=${Date.now()}`)).then((r) => (r.ok ? r.json() : null)).then(setAggregate).catch(() => {});
    setTab('insights');
  }, [phase, runId]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      const w = Math.floor(Math.min(width, height * (STAGE_W / STAGE_H)));
      setBox({ w, h: Math.floor(w * (STAGE_H / STAGE_W)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !box.w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(box.w * dpr); c.height = Math.round(box.h * dpr);
  }, [box]);

  // On the main page every Begin plays a randomly chosen recorded performance, so each viewing tells a
  // different story (hidden water/radio/leg conditions and the agents' own choices differ per run).
  const begin = useCallback(async () => {
    if (!perf.current) return;
    sound.current.start();
    const v3 = runs.filter((r) => r.rules === 'v3');   // performances recorded under the current rules
    const pool = (v3.length ? v3 : runs.filter((r) => r.mode && r.mode !== 'legacy')).map((r) => r.id);
    if (!RUN && !LIVE && pool.length) {
      const choices = pool.length > 1 ? pool.filter((id) => id !== record?.run_id) : pool;
      const id = choices[Math.floor(Math.random() * choices.length)];
      const rec: PerformanceRecord = await (await fetch(url(`/performance/runs/${id}/decision-record.json`))).json();
      const voices = await loadVoices(decoder.current, url(`/performance/runs/${id}/voices`));
      perf.current.setRecord(rec); perf.current.setVoices(voices);
      setRecord(rec);
    }
    setStarted(true); setPlayed(0); setSubtitle(null); setTab('log'); setInsights(null);
    perf.current.begin();
  }, [runs, record]);

  useEffect(() => { const el = logRef.current; if (el && tab === 'log') el.scrollTop = el.scrollHeight; }, [played, phase, tab]);

  const dt = (x: string | null | undefined) => displayText(record, x);
  const turns = record?.turns ?? [];
  const byTurn = Object.fromEntries(turns.map((t) => [t.turn, t]));
  const ending = record?.ending ?? null;
  const st = ending ? statusOf(ending) : null;
  const finalPhase = phase === 'final' || phase === 'done';
  const canBegin = ready && !!record;

  return (
    <div className="app">
      <div className="stage-col">
        <header className="topbar">
          <h1>The Third Survivor</h1>
          <span className="sub">Sam, Welsy and Elizabeth: every move and line decided live by independent agents</span>
          {started && <button onClick={begin} disabled={!canBegin}>{phase === 'done' ? 'Begin again' : 'Begin'}</button>}
          {LIVE && record?.status === 'running' && <span className="live">● LIVE</span>}
          {runs.length > 0 && (
            <select className="run-select" value={RUN ?? ''} onChange={(ev) => { window.location.search = ev.target.value ? `?run=${ev.target.value}` : ''; }}>
              <option value="">Random story each Begin</option>
              {runs.map((r) => <option key={r.id} value={r.id}>{r.id}{r.mode ? ` (${r.mode})` : ''}: boat {r.rescued.map((w) => NAMES[w]).join('+') || 'none'}</option>)}
            </select>
          )}
        </header>

        <div className="stage-wrap" ref={wrapRef}>
          <div className="stage-box" style={{ width: box.w, height: box.h }}>
            <canvas ref={canvasRef} style={{ width: box.w, height: box.h }} />
            {subtitle && (
              <div className={`subtitle ${subtitle.who === 'radio' ? 'radio' : ''}`} key={`${turnIndex}-${subtitle.who}`}>
                {subtitle.who === 'radio'
                  ? <><b>📻 Radio</b> {subtitle.text}</>
                  : <><b style={{ color: COLOR[subtitle.who] }}>{NAMES[subtitle.who]}</b> <span className="to">to {subtitle.to.map((w) => NAMES[w]).join(' & ')}</span><br />{subtitle.text}</>}
              </div>
            )}
            {!started && (
              <div className="curtain">
                <h2>The Third Survivor</h2>
                <p>Sam, Welsy and Elizabeth survive a plane crash. A storm is coming.<br />Every move and line was decided by an independent agent: no fixed order, 15 turns.</p>
                {error ? <p className="err">{error}</p> : (
                  <button onClick={begin} disabled={!canBegin}>{canBegin ? 'Begin performance (sound on)' : 'Loading…'}</button>
                )}
              </div>
            )}
            {phase === 'done' && ending && st && (
              <div className="ending-card">
                <h3>After turn {turns.length}</h3>
                {WHO.map((w) => (
                  <p key={w}><b style={{ color: COLOR[w] }}>{NAMES[w]}</b> — <b>{STATUS_LABEL[st.status[w]]}</b>: {st.how[w]}
                    {ending.goal && <span className="goal"> · goal {ending.goal[w].met ? 'met' : 'not met'} ({ending.goal[w].detail})</span>}</p>
                ))}
                <p className="hidden-reveal">
                  Starting conditions: radio {ending.hidden.radio === 'repairable' ? 'working' : 'broken beyond repair'} ·
                  Sam's leg {ending.hidden.mobility === 'needs_help' ? 'fractured' : 'bruised'} · water {ending.hidden.water === 'clean' ? 'clean' : 'polluted'}
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="caption">{started ? caption : <span className="muted">Press Begin to start the performance.</span>}</div>
      </div>

      <aside className="record" ref={logRef}>
        <div className="tabs">
          <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Decision log</button>
          <button className={tab === 'insights' ? 'on' : ''} disabled={phase !== 'done'} onClick={() => setTab('insights')}>Insights</button>
        </div>
        {tab === 'log' && <>
          <p className="log-sub">Who took each turn, what they did and said, and why, in the agents' own words.</p>
          {turns.slice(0, played).map((t, i) => {
            const to = addresseesOf(t);
            const speaker = t.spoken_line ? ((t.speaker ?? t.actor) as Who) : null;
            const src = t.influenced_by_turn ? byTurn[t.influenced_by_turn] : null;
            return (
              <div key={t.turn} className={`entry ${turnIndex === i ? 'now' : ''}`}>
                <div className="entry-head"><span className="tag" style={{ background: COLOR[t.actor] }}>Turn {t.turn} · {NAMES[t.actor]} ({ROLE[t.actor]})</span><span className="storm">storm {t.storm}/5</span></div>
                <div className="row"><span className="k">🎬 Action</span><span><b>{t.action ?? t.event.type}</b>{targetOf(t) ? <> → {dt(String(targetOf(t)))}</> : null}</span></div>
                <div className="row"><span className="k">🎭 Stage</span><span className="direction">{dt(t.stage_direction || t.visible_action)}</span></div>
                <div className="row"><span className="k">🚶 Moves</span><span>{movementOf(t)}</span></div>
                <div className="row"><span className="k">💬 Spoke</span><span>{speaker ? <><b>{NAMES[speaker]}</b> <span className="to">to {to.map((w) => NAMES[w]).join(' & ')}:</span> <span className="line">“{dt(t.spoken_line)}”</span></> : <span className="muted">silent turn</span>}</span></div>
                {t.reason && <div className="row think"><span className="k">🧠 Thinks</span><span>{dt(t.reason)}</span></div>}
                {t.private_result && <div className="row private"><span className="k">🔒 Learns</span><span>{dt(t.private_result)} <i>(only {NAMES[t.actor]} knows)</i></span></div>}
                <div className="row"><span className="k">⚙️ Result</span><span>{dt(t.state_change)}</span></div>
                {t.plan_changed ? (
                  <div className="plan changed">
                    <b>Plan changed</b>{t.influenced_by_turn ? <> because of <b>turn {t.influenced_by_turn}</b></> : null}
                    {src && <div className="quote">“{dt(src.stage_direction || src.visible_action)}”{src.spoken_line ? <> {NAMES[src.actor]}: “{dt(src.spoken_line)}”</> : null}</div>}
                    <div className="was">was: {dt(t.previous_plan)}</div>
                    <div>now: {dt(t.current_plan)}</div>
                  </div>
                ) : (
                  <div className="plan">plan: {dt(t.current_plan) || '—'}{t.influenced_by_turn ? ` (responding to turn ${t.influenced_by_turn})` : ''}</div>
                )}
              </div>
            );
          })}
          {finalPhase && ending && st && (
            <div className="entry now">
              <div className="entry-head"><span className="tag" style={{ background: '#555' }}>After turn {turns.length}</span></div>
              {WHO.map((w) => <div key={w} className="row"><span className="k" style={{ color: COLOR[w] }}>{NAMES[w]}</span><span><b>{STATUS_LABEL[st.status[w]]}</b>: {st.how[w]}</span></div>)}
            </div>
          )}
          {!record && !error && <p className="muted">Loading the decision record…</p>}
        </>}

        {tab === 'insights' && (
          <div className="insights">
            {!insights && <p className="muted">No Bruin insights for this run yet (run <code>node stage/insights.mjs</code>).</p>}
            {insights && <>
              <h3>Who spoke the most</h3>
              <table><thead><tr><th></th><th>turns taken</th><th>spoken turns</th><th>words</th></tr></thead>
                <tbody>{insights.speaking.map((r) => <tr key={r.agent}><td>{r.agent}</td><td>{r.turns_taken}</td><td>{r.spoken_turns}</td><td>{r.spoken_words}</td></tr>)}</tbody></table>
              <p className="muted">Most spoken turns: <b>{insights.most_spoken_by_turns}</b> · most words: <b>{insights.most_spoken_by_words}</b></p>
              <h3>Changes of plan</h3>
              {!insights.plan_changes.length && <p className="muted">Nobody changed plan.</p>}
              {insights.plan_changes.map((c) => (
                <div key={c.turn} className="ins-change">
                  <b>Turn {c.turn}: {c.agent}</b>{c.prompted_by_turn ? <> changed plan after turn {c.prompted_by_turn} ({c.prompted_by_agent}):</> : ' changed plan:'}
                  {c.prompt_stage_direction && <div className="quote">“{c.prompt_stage_direction}”{c.prompt_line ? <> {c.prompted_by_agent}: “{c.prompt_line}”</> : null}</div>}
                  <div className="think">{c.agent}: “{c.reason}”</div>
                </div>
              ))}
              <h3>Survival and goals</h3>
              {insights.survival.map((r) => <p key={r.character}><b>{r.character}</b>: {r.status_label} ({r.how}). Goal {r.goal_met ? '✓ met' : '✗ not met'}: {r.goal_detail}.</p>)}
            </>}
            {aggregate && <>
              <h3>Across {aggregate.runs.length} runs: before vs after training</h3>
              {!aggregate.training.length && <p className="muted">No training runs yet.</p>}
              {aggregate.training.length > 0 && (
                <table><thead><tr><th></th><th>policy</th><th>runs</th><th>survived</th><th>goal met</th></tr></thead>
                  <tbody>{aggregate.training.map((r) => <tr key={r.character + r.phase}><td>{r.character}</td><td>{r.phase}</td><td>{r.runs}</td><td>{pct(r.survival_rate)}</td><td>{pct(r.goal_rate)}</td></tr>)}</tbody></table>
              )}
              <h3>Who speaks most, all runs</h3>
              <table><thead><tr><th></th><th>runs</th><th>spoken turns</th><th>words</th></tr></thead>
                <tbody>{aggregate.speaking.map((r) => <tr key={r.agent}><td>{r.agent}</td><td>{r.runs}</td><td>{r.spoken_turns}</td><td>{r.spoken_words}</td></tr>)}</tbody></table>
              <p className="muted">Source: Bruin pipeline <code>bruin/third-survivor</code> (tables insights.speaking, insights.plan_changes, insights.survival, insights.training).</p>
            </>}
          </div>
        )}
      </aside>
    </div>
  );
}
