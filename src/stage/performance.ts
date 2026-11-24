// Playback engine for The Third Survivor. Reads a decision record (any run, live or replay),
// maps each recorded action to a reusable animation, and renders the beach, cutout rigs, the
// on-demand shelter and patrol boat to a canvas. A turn advances only when its movement,
// gesture and dialogue have all finished. Survival is shown only after the last turn.
import { drawCharacter, REST, type Held, type MouthShape, type Pose, type Rig, type Side, type Who } from './rig';
import { fallbackDuration, mouthCycle, mouthFromLevel, type Clip } from './voice';
import {
  addresseesOf, boatComes, displayText, INITIAL, NAMES, statusOf, WHO,
  type PerformanceRecord, type Snapshot, type Spot, type Status, type Turn,
} from './types';
import type { Soundscape } from '../sound';

export const STAGE_W = 1568;
export const STAGE_H = 882;

// Invisible position anchors on dry sand (the point between a character's feet). Checked against the dry-sand map.
export const ANCHOR: Record<Spot, [number, number]> = {
  wreckage: [478, 528],    // left, beside the plane debris
  dry_spot: [800, 262],    // toward the top, below the rocks
  shoreline: [1190, 540],  // right, the pickup point (kept well clear of the surf)
};
const PICKUP: [number, number][] = [[1160, 615], [1250, 575]];   // final-pickup markers on dry sand next to the boat
const BOAT = { w: 400, dockX: 1140, top: 612, enterX: 1640, leaveX: 1720 };   // top-left x positions; always over water
const DECK: [number, number][] = [[0.76, 0.6], [0.86, 0.58]];                 // feet points on the deck (fractions of the sprite)
const SHELTER = { cx: 800, bottom: 256, w: 250 };
const SEATS: Record<Who, [number, number]> = { A: [738, 254], B: [800, 250], C: [862, 254] };   // separate seats under the roof
const SLOT: Record<Who, number> = { A: -1, B: 0, C: 1 };
const SLOT_GAP = 104;
const RADIO: [number, number] = [300, 556];
const BOTTLE_AT: Record<Spot, [number, number]> = { wreckage: [408, 600], dry_spot: [690, 292], shoreline: [1050, 585] };
const WALK_ARC = 62;
const WALK_SPEED = 170;
const STRIDE = 34;
const CHAR_HEIGHT = 200;
const OPENING_S = 4.5;
const TURN_PAD_S = 0.7;
const BUILD_S = 5;

const depth = (y: number) => 0.84 + 0.26 * (y - 262) / (592 - 262);
export function slotPos(spot: Spot, who: Who): [number, number] {
  const [x, y] = ANCHOR[spot];
  return [x + SLOT[who] * SLOT_GAP * depth(y), y];
}

export interface Scene {
  dry: { cell: number; w: number; h: number; rows: string[] };
  boat: HTMLImageElement; shelter: HTMLImageElement;
}

type GestureKind = 'work' | 'call' | 'examine' | 'hold_up' | 'pickup' | 'handover' | 'open' | 'plant' | 'slump' | 'point' | 'build';
const RECORD_GESTURE: Record<string, GestureKind | null> = {
  none: null, work: 'work', call: 'call', examine: 'examine', hold_up: 'hold_up', pickup: 'pickup', handover: 'handover',
  open_arms: 'open', plant: 'plant', slump: 'slump', point: 'point', build: 'build',
};
interface Char {
  who: Who; x: number; y: number; facing: 1 | -1; spot: Spot | 'boat';
  pose: Pose; phase: number; walking: boolean; mouth: MouthShape;
  gesture: { kind: GestureKind; t: number; dur: number } | null;
  stumble: { t: number; dur: number; dir: number } | null;
  hop: number; alpha: number; deck: number | null; final: Status | null;
  down: boolean; seated: boolean; support: 'carried' | 'helper' | null; fadeT: number;
}
interface Track { update(dt: number): boolean }
export type Phase = 'idle' | 'loading' | 'opening' | 'playing' | 'final' | 'done';
export interface Subtitle { who: Who | 'radio'; to: Who[]; text: string }
export interface StageEvents {
  onPhase(p: Phase): void;
  onTurn(index: number | null): void;
  onSubtitle(s: Subtitle | null): void;
  onCaption(text: string): void;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (k: number) => (k < 0 ? 0 : k > 1 ? 1 : k * k * (3 - 2 * k));

export class Performance {
  private chars = {} as Record<Who, Char>;
  private shown: Snapshot = INITIAL;
  private tracks: Track[] = [];
  private turnIndex = -1;
  private phase: Phase = 'idle';
  private phaseT = 0;
  private pad = 0;
  private storm = 1;
  private flash = 0;
  private speaker: { who: Who } | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private raf = 0;
  private last = 0;
  private drops = Array.from({ length: 260 }, () => [Math.random() * STAGE_W, Math.random() * STAGE_H, 0.6 + Math.random() * 0.8]);
  private nextBolt = 6;
  private boat: { x: number; visible: boolean; t: number } = { x: BOAT.enterX, visible: false, t: 0 };
  private build: { t: number; dur: number } | null = null;
  private markers = false;
  private prologue: { who: Who; line: string }[] = [];
  private prologueClips: Record<number, Clip> = {};

  constructor(
    private ctx: CanvasRenderingContext2D, private rig: Rig, private bg: HTMLImageElement, private scene: Scene,
    private sound: Soundscape, private ev: StageEvents,
    private record: PerformanceRecord, private voices: Record<number, Clip>,
  ) { this.reset(); }

  setRecord(r: PerformanceRecord) { this.record = r; }
  private text(s: string | null | undefined) { return displayText(this.record, s); }
  /** Sam's leg from the run's recorded starting conditions (fractured = lies on the sand). */
  private fractured() { const r = this.record as any; return (r?.hidden ?? r?.ending?.hidden ?? r?.meta?.hidden)?.mobility === 'needs_help'; }
  setVoices(v: Record<number, Clip>) { this.voices = v; }
  /** Opening scene spoken before turn 1 (same for every run). */
  setPrologue(lines: { who: Who; line: string }[], clips: Record<number, Clip>) { this.prologue = lines; this.prologueClips = clips; }

  /** Begin (or restart): reset positions, props, shelter, boat, mouths and audio, then play from the opening. */
  begin() {
    this.stopVoices();
    this.sound.resetFx();
    this.reset();
    this.setPhase('opening');
    if (this.prologue.length) {
      const steps: (() => Track)[] = [() => this.after(1.5, () => {})];
      this.prologue.forEach((p, i) => steps.push(() => this.sayTrack(p.who, p.line, this.prologueClips[i + 1], WHO.filter((w) => w !== p.who))));
      steps.push(() => this.after(0.6, () => { this.ev.onSubtitle(null); this.setPhase('playing'); }));
      this.tracks.push(this.seq(steps));
    }
    this.ev.onCaption('Crash aftermath. Sam, Welsy and Elizabeth stand by the wreckage; a damaged radio and two water bottles lie within reach. A storm is coming.');
    if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(this.frame); }
  }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; this.stopVoices(); this.sound.resetFx(); }
  private stopVoices() { for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } } this.sources = []; }

  private reset() {
    for (const w of WHO) {
      const [x, y] = slotPos('wreckage', w);
      this.chars[w] = { who: w, x, y, facing: 1, spot: 'wreckage', pose: { ...REST }, phase: 0, walking: false, mouth: 'closed', gesture: null, stumble: null, hop: 0, alpha: 1, deck: null, final: null, down: w === 'A' && this.fractured(), seated: false, support: null, fadeT: 0 };
    }
    this.shown = JSON.parse(JSON.stringify(INITIAL));
    this.tracks = []; this.turnIndex = -1; this.pad = 0; this.storm = 1; this.flash = 0; this.speaker = null;
    this.boat = { x: BOAT.enterX, visible: false, t: 0 }; this.build = null; this.markers = false;
    this.sound.setStorm(1);
    this.ev.onTurn(null); this.ev.onSubtitle(null);
    this.draw();
  }

  private setPhase(p: Phase) { this.phase = p; this.phaseT = 0; this.ev.onPhase(p); }

  private frame = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.update(dt);
    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  isDry(x: number, y: number) {
    const d = this.scene.dry, r = Math.floor(y / d.cell), c = Math.floor(x / d.cell);
    return r >= 0 && r < d.h && c >= 0 && c < d.w && d.rows[r][c] === '1';
  }

  // ---------------------------------------------------------------- timeline
  private update(dt: number) {
    this.phaseT += dt;
    if (this.phase === 'opening' && !this.prologue.length && this.phaseT >= OPENING_S) this.setPhase('playing');
    if (this.phase === 'opening' || this.phase === 'playing' || this.phase === 'final') {
      this.tracks = this.tracks.filter((t) => !t.update(dt));
      if (!this.tracks.length && this.phase !== 'opening') {
        this.pad += dt;
        if (this.phase === 'playing' && (this.turnIndex < 0 || this.pad >= TURN_PAD_S)) this.nextTurn();
        else if (this.phase === 'final' && this.pad >= 2) this.setPhase('done');
      }
    }
    if (this.storm >= 3) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.nextBolt = 5 + Math.random() * (14 - this.storm * 2);
        this.flash = 0.22;
        const s = this.storm;
        setTimeout(() => this.sound.thunder(0.35 + s * 0.12), 400 + Math.random() * 900);
      }
    }
    this.flash = Math.max(0, this.flash - dt);
    this.boat.t += dt;
    if (this.build) this.build.t += dt;
    for (const c of Object.values(this.chars)) this.animate(c, dt);
    this.publishDebug();
  }

  private nextTurn() {
    this.pad = 0;
    this.speaker = null;
    this.ev.onSubtitle(null);
    for (const c of Object.values(this.chars)) c.mouth = 'closed';
    const turns = this.record.turns;
    if (this.turnIndex + 1 < turns.length) {
      this.turnIndex += 1;
      this.playTurn(turns[this.turnIndex], this.turnIndex > 0 ? turns[this.turnIndex - 1].snapshot : INITIAL);
      return;
    }
    if (this.record.ending) { this.playEnding(); return; }
    this.ev.onTurn(null);   // live run still in progress: wait for the next recorded turn
  }

  // ---------------------------------------------------------------- action → animation (reusable for any run)
  private playTurn(t: Turn, before: Snapshot) {
    this.ev.onTurn(this.turnIndex);
    this.ev.onCaption(`Turn ${t.turn} · ${NAMES[t.actor]}: ${this.text(t.stage_direction || t.visible_action)}`);
    this.storm = t.storm;
    this.sound.setStorm(t.storm);
    const after = t.snapshot, e = t.event, actor = this.chars[t.actor];
    const applyAfter = () => { this.shown = { ...after, holdings: JSON.parse(JSON.stringify(after.holdings)), ground: JSON.parse(JSON.stringify(after.ground)) }; };
    this.shown = { ...before, shelterBuilt: !!before.shelterBuilt };
    let applied = false;
    const contact = () => { if (!applied) { applied = true; applyAfter(); } };

    // 1) movement: walk anyone whose recorded position changed (assisted pairs walk together)
    const seatOf = (w: Who) => (after.sheltering ?? []).includes(w);
    const dest = (w: Who) => (seatOf(w) ? SEATS[w] : slotPos(after.positions[w], w));
    const movers = WHO.filter((w) => after.positions[w] !== this.chars[w].spot || seatOf(w) !== this.chars[w].seated);
    const arrive = (ws: Who[]) => () => this.after(0, () => { for (const w of ws) { const c = this.chars[w]; c.seated = seatOf(w); c.support = null; if (w === 'A') c.down = this.fractured(); } });
    const go = (ws: Who[]) => {
      for (const w of ws) { this.chars[w].seated = false; if (w === 'A') this.chars.A.down = false; }
      if (ws.includes('A') && ws.length > 1 && this.fractured()) for (const w of ws) this.chars[w].support = w === 'A' ? 'carried' : 'helper';
      this.tracks.push(this.seq([() => this.walk(ws, dest), arrive(ws)]));
    };
    if (e.type === 'assist_a' && movers.length) go(movers);
    else for (const w of movers) go([w]);
    if (e.type === 'move_failed') this.tracks.push(this.stumbleTrack(this.chars.A, e.attempt ? slotPos(e.attempt, 'A')[0] : this.chars.A.x + 1));

    // 2) the action (record gesture when present, else the closest supported default)
    const voiceDur = this.lineDuration(t);
    const recorded = t.gesture !== undefined ? RECORD_GESTURE[t.gesture] ?? null : undefined;
    const g = (fallback: GestureKind | null) => (recorded === undefined ? fallback : recorded ?? fallback);
    const to = addresseesOf(t);
    switch (e.type) {
      case 'diagnose_radio': case 'inspect_radio':
        this.face(actor, RADIO[0]); this.sound.staticHiss();
        this.tracks.push(this.gestureTrack(actor, g('work') ?? 'work', Math.max(3, voiceDur * 0.8)));
        break;
      case 'repair_radio':
        this.face(actor, RADIO[0]); this.sound.staticHiss();
        this.tracks.push(this.gestureTrack(actor, 'work', Math.max(3.4, voiceDur * 0.8), 0.75, () => { contact(); if (after.radioWorking) this.sound.chime(); }));
        break;
      case 'call_rescue': {
        this.face(actor, RADIO[0]); this.sound.staticHiss();
        const reply = after.callConfirmed ? (t.visible_action.match(/back:\s*"(.*)"/)?.[1] ?? 'Patrol boat confirms.') : '(static, no answer)';
        this.tracks.push(this.gestureTrack(actor, 'call', voiceDur + 0.4));
        this.tracks.push(this.after(voiceDur + 0.5, () => {
          this.sound.staticHiss(); if (after.callConfirmed) this.sound.chime();
          this.ev.onSubtitle({ who: 'radio', to: [], text: reply });
        }, 3.2));
        break;
      }
      case 'assess_mobility':
        this.face(actor, this.chars.A.x);
        this.tracks.push(this.gestureTrack(actor, 'examine', Math.max(3, voiceDur)));
        break;
      case 'check_water': case 'inspect_bottle': {
        const holding = (before.holdings[t.actor] ?? []).some((i) => i.startsWith('bottle'));
        if (!holding) this.face(actor, BOTTLE_AT[before.positions[t.actor]][0]);
        this.tracks.push(this.gestureTrack(actor, holding ? 'hold_up' : 'examine', Math.max(3, voiceDur)));
        break;
      }
      case 'build_shelter':
        this.face(actor, SHELTER.cx + 1);
        this.build = { t: 0, dur: BUILD_S };
        this.tracks.push(this.gestureTrack(actor, 'build', BUILD_S, 0.85, () => { contact(); this.build = null; this.sound.chime(); }));
        break;
      case 'take': case 'drop': {
        if (e.type === 'take') this.face(actor, BOTTLE_AT[after.positions[t.actor]][0]);
        this.tracks.push(this.gestureTrack(actor, 'pickup', 1.8, 0.5, () => { contact(); this.sound.chime(); }));
        break;
      }
      case 'hand_over': {
        const r = e.recipient && e.recipient in this.chars ? this.chars[e.recipient as Who] : null;
        if (r) { this.face(actor, r.x); this.face(r, actor.x); }
        this.tracks.push(this.gestureTrack(actor, 'handover', 2, 0.55, () => { contact(); this.sound.chime(); }));
        break;
      }
      case 'commit_to_boarding':
        this.sound.chime();
        this.tracks.push(this.gestureTrack(actor, 'plant', 2));
        break;
      case 'give_up_place':
        this.tracks.push(this.gestureTrack(actor, 'slump', 2.2));
        break;
      case 'offer': case 'respond': case 'wait': {
        const kind = g(e.type === 'wait' ? null : 'open');
        if (kind) {
          if (kind === 'point' && to[0]) this.face(actor, this.chars[to[0]].x);
          this.tracks.push(this.gestureTrack(actor, kind, Math.max(2, voiceDur)));
        }
        break;
      }
      default: break;   // move / assist / failed move: the movement carries the turn
    }
    if (!['take', 'drop', 'hand_over', 'repair_radio', 'build_shelter'].includes(e.type)) contact();

    // 3) dialogue alongside the action; addressed listeners turn toward the speaker (mouths stay closed)
    if (t.spoken_line) {
      for (const w of to) if (!movers.includes(w)) { this.face(this.chars[w], actor.x); this.chars[w].hop = 0.45; }
      this.tracks.push(this.speech(t, to));
    }
  }

  /** After the last turn: survival is shown only now. Boat only if a call succeeded; boarding never touches the water. */
  private playEnding() {
    const r = this.record, e = r.ending!;
    const { status } = statusOf(e);
    this.turnIndex = r.turns.length;
    this.ev.onTurn(null);
    this.setPhase('final');
    this.pad = 0;
    this.storm = 5;
    this.sound.setStorm(5);
    this.ev.onCaption(this.text(e.finalBeat));
    const rescued = WHO.filter((p) => status[p] === 'rescued');
    for (const p of WHO) if (status[p] !== 'rescued') this.chars[p].final = status[p];   // 'died' fades out below (kept offscreen)
    if (!boatComes(r)) { this.sound.thunder(1.4); this.flash = 0.45; return; }
    const steps: (() => Track)[] = [
      () => { this.boat = { x: BOAT.enterX, visible: true, t: 0 }; return this.boatTo(BOAT.dockX, 4); },
      () => { this.sound.horn(); this.markers = true; return this.after(0.6, () => {}); },
    ];
    if (rescued.length) {
      steps.push(() => this.walk(rescued, (w) => PICKUP[rescued.indexOf(w)], false, false));
      rescued.forEach((w, i) => steps.push(() => this.boardTrack(this.chars[w], i)));
    } else steps.push(() => this.after(1.5, () => {}));
    steps.push(() => this.after(0.8, () => { this.markers = false; }), () => this.boatTo(BOAT.leaveX, 4));
    this.tracks.push(this.seq(steps));
  }

  // ---------------------------------------------------------------- tracks
  private seq(steps: (() => Track)[]): Track {
    let i = 0, cur: Track | null = null;
    return { update: (dt) => { while (i < steps.length) { if (!cur) cur = steps[i](); if (!cur.update(dt)) return false; cur = null; i++; } return true; } };
  }

  /** Pick a path bow that keeps every footstep on dry sand (prefer bowing toward the camera). */
  private arcFor(fx: number, fy: number, tx: number, ty: number) {
    for (const arc of [WALK_ARC, -WALK_ARC, WALK_ARC / 2, -WALK_ARC / 2, 0]) {
      let ok = true;
      for (let k = 0; k <= 1.0001 && ok; k += 0.04) ok = this.isDry(lerp(fx, tx, k), lerp(fy, ty, k) + arc * Math.pow(Math.sin(Math.PI * k), 0.4));
      if (ok) return arc;
    }
    return 0;
  }

  private walk(who: Who[], dest: (w: Who) => [number, number], sameTime = true, arcs = true): Track {
    const legs = who.map((w) => {
      const c = this.chars[w], [tx, ty] = dest(w);
      return { c, fx: c.x, fy: c.y, tx, ty, d: Math.hypot(tx - c.x, ty - c.y), arc: arcs ? this.arcFor(c.x, c.y, tx, ty) : 0 };
    });
    const speed = WALK_SPEED * depth((legs[0].fy + legs[0].ty) / 2);
    const dur = Math.max(...legs.map((l) => l.d)) / speed;
    let t = 0;
    for (const l of legs) { l.c.gesture = null; if (Math.abs(l.tx - l.fx) > 2) l.c.facing = l.tx > l.fx ? 1 : -1; }
    return {
      update: (dt) => {
        t += dt;
        for (const l of legs) {
          const ld = sameTime ? dur : l.d / speed;
          const k = Math.min(1, t / Math.max(0.01, ld));
          const nx = lerp(l.fx, l.tx, k), ny = lerp(l.fy, l.ty, k) + l.arc * Math.pow(Math.sin(Math.PI * k), 0.4);
          const moved = Math.hypot(nx - l.c.x, ny - l.c.y);
          l.c.x = nx; l.c.y = ny;
          l.c.phase += (moved / (STRIDE * depth(ny))) * Math.PI;
          l.c.walking = k < 1;
          if (k >= 1) l.c.spot = (Object.keys(ANCHOR) as Spot[]).find((s) => Math.hypot(ANCHOR[s][0] - l.tx, ANCHOR[s][1] - l.ty) < 200) ?? l.c.spot;
        }
        return legs.every((l) => !l.c.walking);
      },
    };
  }

  private boatTo(x: number, dur: number): Track {
    const from = this.boat.x;
    let t = 0;
    return { update: (dt) => { t += dt; this.boat.x = lerp(from, x, ease(t / dur)); if (t >= dur && x >= BOAT.leaveX) this.boat.visible = false; return t >= dur; } };
  }

  /** Quick fade at the dry-sand marker, then the character reappears on the boat deck. */
  private boardTrack(c: Char, slot: number): Track {
    let t = 0, moved = false;
    return {
      update: (dt) => {
        t += dt;
        if (t < 0.35) c.alpha = 1 - t / 0.35;
        else { if (!moved) { moved = true; c.deck = slot; c.spot = 'boat'; this.sound.chime(); } c.alpha = Math.min(1, (t - 0.35) / 0.35); }
        return t >= 0.75;
      },
    };
  }

  private gestureTrack(c: Char, kind: GestureKind, dur: number, contactAt?: number, onContact?: () => void): Track {
    c.gesture = { kind, t: 0, dur };
    let fired = false;
    return {
      update: (dt) => {
        if (!c.gesture) return true;
        c.gesture.t += dt;
        if (onContact && !fired && c.gesture.t >= (contactAt ?? 0.5) * dur) { fired = true; onContact(); }
        if (c.gesture.t >= dur) { c.gesture = null; return true; }
        return false;
      },
    };
  }

  private stumbleTrack(c: Char, towardX: number): Track {
    c.stumble = { t: 0, dur: 2.8, dir: towardX >= c.x ? 1 : -1 };
    c.facing = c.stumble.dir as 1 | -1;
    let thud = false;
    return {
      update: (dt) => {
        if (!c.stumble) return true;
        c.stumble.t += dt;
        if (!thud && c.stumble.t > 0.75) { thud = true; this.sound.thud(); }
        if (c.stumble.t >= c.stumble.dur) { c.stumble = null; return true; }
        return false;
      },
    };
  }

  private after(delay: number, fn: () => void, hold = 0): Track {
    let t = 0, fired = false;
    return { update: (dt) => { t += dt; if (!fired && t >= delay) { fired = true; fn(); } return t >= delay + hold; } };
  }

  private lineDuration(t: Turn) {
    if (!t.spoken_line) return 0;
    return this.voices[t.turn]?.duration ?? fallbackDuration(t.spoken_line);
  }

  /** Play the turn's voice clip (or a timed fallback) and drive only the speaker's mouth. */
  private speech(t: Turn, to: Who[]): Track {
    return this.sayTrack((t.speaker ?? t.actor) as Who, this.text(t.spoken_line), this.voices[t.turn], to);
  }

  /** Speak one line: voice clip (or timed fallback), subtitle, and only this speaker's mouth moves. */
  private sayTrack(speakerId: Who, line: string, clip: Clip | undefined, to: Who[]): Track {
    const dur = clip?.duration ?? fallbackDuration(line);
    const delay = 0.3;
    let t0 = 0, started = false, startedAt = 0;
    const ac = this.sound.context;
    return {
      update: (dt) => {
        t0 += dt;
        if (!started && t0 >= delay) {
          started = true;
          this.ev.onSubtitle({ who: speakerId, to, text: line });
          if (clip && ac) {
            const src = ac.createBufferSource();
            src.buffer = clip.buffer; src.connect(this.sound.bus);
            startedAt = ac.currentTime; src.start(startedAt);
            this.sources.push(src);
            src.onended = () => { this.sources = this.sources.filter((x) => x !== src); };
          }
          this.speaker = { who: speakerId };
        }
        if (!started) return false;
        const elapsed = clip && ac ? ac.currentTime - startedAt : t0 - delay;
        const c = this.chars[speakerId];
        c.mouth = clip ? mouthFromLevel(clip, elapsed) : mouthCycle(elapsed, dur);
        if (elapsed >= dur) { c.mouth = 'closed'; this.speaker = null; return true; }
        return false;
      },
    };
  }

  private face(c: Char, x: number) { if (Math.abs(x - c.x) > 3) c.facing = x > c.x ? 1 : -1; }

  // ---------------------------------------------------------------- posing
  private animate(c: Char, dt: number) {
    const target: Pose = { ...REST };
    if (c.walking) {
      const s = Math.sin(c.phase), co = Math.cos(c.phase);
      target.thigh_l = -24 * s; target.thigh_r = 24 * s;
      target.knee_l = 6 + 20 * Math.max(0, co); target.knee_r = 6 + 20 * Math.max(0, -co);
      target.shoulder_l = REST.shoulder_l + 20 * s; target.shoulder_r = REST.shoulder_r - 20 * s;
      target.elbow_l = -10 - 8 * Math.max(0, -s); target.elbow_r = -10 - 8 * Math.max(0, s);
      target.bodyY = -9 * Math.abs(co) + 4;
      if (c.support === 'carried') { target.thigh_r = 6; target.knee_r = 4; target.lean = 9; target.shoulder_r = -150; target.elbow_r = -30; target.bodyY += 6; }   // leans on the helper, injured leg stiff
      if (c.support === 'helper') { target.shoulder_l = -60; target.elbow_l = -25; }                                                                            // supports Sam
      c.pose = target;
      return;
    }
    if (c.stumble) {
      const k = c.stumble.t;
      const fall = k < 0.45 ? 0 : k < 0.85 ? ease((k - 0.45) / 0.4) : k < 1.7 ? 1 : 1 - ease((k - 1.7) / 1.0);
      const step = k < 0.45 ? Math.sin((k / 0.45) * Math.PI) : 0;
      target.thigh_l = -22 * step; target.knee_l = 10 * step;
      target.lean = 62 * fall; target.bodyY = 70 * fall;
      target.thigh_r = -30 * fall; target.knee_r = 50 * fall;
      target.shoulder_l = REST.shoulder_l + 40 * fall; target.shoulder_r = REST.shoulder_r - 50 * fall;
    } else if (c.gesture) {
      const g = c.gesture, env = Math.min(ease(g.t / 0.35), ease((g.dur - g.t) / 0.35));
      const wob = Math.sin(g.t * 9);
      const set = (p: Partial<Pose>) => { for (const [k, v] of Object.entries(p)) (target as any)[k] = lerp((REST as any)[k], v as number, env); };
      switch (g.kind) {
        case 'work': set({ lean: 12, bodyY: 12, shoulder_r: -48 + 6 * wob, elbow_r: -34, shoulder_l: -30 - 6 * wob, elbow_l: -30 }); break;
        case 'call': set({ shoulder_r: -28, elbow_r: -128, shoulder_l: 10, elbow_l: -6, head: -3 }); break;
        case 'examine': set({ lean: 20, bodyY: 22, shoulder_r: -55 + 4 * wob, elbow_r: -20, shoulder_l: -40, elbow_l: -25 }); break;
        case 'hold_up': set({ shoulder_r: -70 + 3 * Math.sin(g.t * 2.2), elbow_r: -70, shoulder_l: -30, elbow_l: -45, head: -4 }); break;
        case 'pickup': { const dip = Math.sin(Math.min(1, g.t / g.dur) * Math.PI); target.lean = 28 * dip; target.bodyY = 30 * dip; target.shoulder_r = lerp(REST.shoulder_r, -40, dip); target.elbow_r = lerp(REST.elbow_r, -8, dip); target.shoulder_l = lerp(REST.shoulder_l, -20, dip); break; }
        case 'handover': { const reach = Math.sin(Math.min(1, g.t / g.dur) * Math.PI); target.shoulder_r = lerp(REST.shoulder_r, -82, reach); target.elbow_r = lerp(REST.elbow_r, -6, reach); target.lean = 6 * reach; break; }
        case 'open': set({ shoulder_l: 38 + 8 * wob, shoulder_r: -38 - 8 * wob, elbow_l: 24, elbow_r: -24 }); break;
        case 'point': set({ shoulder_r: -86, elbow_r: -4, shoulder_l: 8, elbow_l: -6 }); break;
        case 'plant': { const hop = g.t < 0.5 ? Math.sin((g.t / 0.5) * Math.PI) : 0; set({ shoulder_l: 32, shoulder_r: -32, elbow_l: -70, elbow_r: 70 }); target.bodyY -= 26 * hop; break; }
        case 'slump': set({ lean: -6, bodyY: 8, head: 8, shoulder_l: 2, shoulder_r: -2 }); break;
        case 'build': {   // gather wood (bend + reach), then lash it together (alternating arm work)
          const gather = g.t < g.dur * 0.4;
          const bend = gather ? Math.abs(Math.sin(g.t * 3.2)) : 0.3;
          set({ lean: 24 * bend, bodyY: 26 * bend, shoulder_r: gather ? -45 : -60 + 25 * Math.sin(g.t * 8), elbow_r: gather ? -10 : -50, shoulder_l: gather ? -25 : -50 - 25 * Math.sin(g.t * 8), elbow_l: -40 });
          break;
        }
      }
    }
    if (c.down && !c.stumble) { Object.assign(target, { lean: c.seated ? -34 : -78, bodyY: 0, thigh_l: 0, thigh_r: -6, knee_l: 0, knee_r: 0, head: c.seated ? -6 : 0 }); }   // fractured: lying / reclining, can still gesture
    else if (c.seated) { target.bodyY += 95; target.thigh_l = 75; target.thigh_r = -75; target.knee_l = -78; target.knee_r = 78; }                               // sitting under the roof
    if (c.final === 'died') {
      Object.assign(target, { head: 12, shoulder_l: 1, shoulder_r: -1, elbow_l: 0, elbow_r: 0 });
      c.fadeT += dt; c.alpha = Math.max(0, 1 - Math.max(0, c.fadeT - 1.2) / 1.8);   // fade out; the death itself stays offscreen
    }
    if (c.final === 'failed') Object.assign(target, { lean: -5, bodyY: 12, head: 12, shoulder_l: 1, shoulder_r: -1, elbow_l: 0, elbow_r: 0 });
    else if (c.final === 'unresolved') Object.assign(target, { head: 6, bodyY: 4 });
    if (c.hop > 0) { c.hop = Math.max(0, c.hop - dt); target.bodyY -= 22 * Math.sin((1 - c.hop / 0.45) * Math.PI); }
    const k = 1 - Math.exp(-dt * 11);
    for (const key of Object.keys(target) as (keyof Pose)[]) c.pose[key] = lerp(c.pose[key], target[key], k);
  }

  // ---------------------------------------------------------------- drawing
  private boatRect() {
    const h = BOAT.w * (this.scene.boat.height / this.scene.boat.width);
    return { x: this.boat.x, y: BOAT.top + 4 * Math.sin(this.boat.t * 1.6), w: BOAT.w, h };
  }

  private draw() {
    const ctx = this.ctx, { width, height } = ctx.canvas;
    ctx.setTransform(width / STAGE_W, 0, 0, height / STAGE_H, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.bg, 0, 0, STAGE_W, STAGE_H);
    this.drawShelter();
    this.drawRadio();
    for (const spot of Object.keys(BOTTLE_AT) as Spot[]) {
      this.shown.ground[spot].forEach((item, i) => {
        if (!item.startsWith('bottle')) return;
        const [bx, by] = BOTTLE_AT[spot];
        ctx.save(); ctx.translate(bx + i * 24, by); drawBottle(ctx, 30); ctx.restore();
      });
    }
    if (this.markers) for (const [mx, my] of PICKUP) this.drawMarker(mx, my);
    const k = CHAR_HEIGHT / this.rig.height.A;
    const onSand = Object.values(this.chars).filter((c) => c.deck === null).sort((a, b) => a.y - b.y);
    for (const c of onSand) this.drawChar(c, c.x, c.y, k * depth(c.y));
    if (this.boat.visible) {
      const b = this.boatRect();
      ctx.drawImage(this.scene.boat, b.x, b.y, b.w, b.h);
      for (const c of Object.values(this.chars).filter((x) => x.deck !== null)) {
        const [fx, fy] = DECK[c.deck!];
        this.drawChar(c, b.x + fx * b.w, b.y + fy * b.h, k * 0.42);
      }
    }
    const dark = [0, 0, 0.1, 0.2, 0.3, 0.38][this.storm] ?? 0;
    if (dark) { ctx.fillStyle = `rgba(18, 26, 48, ${dark})`; ctx.fillRect(0, 0, STAGE_W, STAGE_H); }
    if (this.storm >= 3) {
      const n = Math.floor(this.drops.length * (this.storm - 2) / 3);
      ctx.strokeStyle = 'rgba(210, 225, 245, 0.45)'; ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const d = this.drops[i];
        d[1] += 22 * d[2]; d[0] -= 6 * d[2];
        if (d[1] > STAGE_H) { d[1] = -20; d[0] = Math.random() * (STAGE_W + 200); }
        ctx.moveTo(d[0], d[1]); ctx.lineTo(d[0] - 7 * d[2], d[1] + 26 * d[2]);
      }
      ctx.stroke();
    }
    if (this.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${Math.min(0.6, this.flash * 2.4)})`; ctx.fillRect(0, 0, STAGE_W, STAGE_H); }
    if (this.phase === 'opening' || this.phase === 'idle') this.drawCallouts();
  }

  private drawChar(c: Char, x: number, y: number, scale: number) {
    if (c.alpha <= 0.01) return;
    this.ctx.save();
    this.ctx.globalAlpha = c.alpha;
    drawCharacter(this.ctx, this.rig, c.who, x, y, scale, c.facing, c.pose, c.mouth, this.heldBy(c.who), drawBottle);
    this.ctx.restore();
  }

  /** Shelter: absent until built. While Welsy builds, wood gathers, then the frame rises; it stays through the ending. */
  private drawShelter() {
    const ctx = this.ctx, img = this.scene.shelter;
    const w = SHELTER.w, h = w * (img.height / img.width), x = SHELTER.cx - w / 2, y = SHELTER.bottom - h;
    if (this.shown.shelterBuilt) { ctx.drawImage(img, x, y, w, h); return; }
    if (!this.build) return;
    const p = Math.min(1, this.build.t / this.build.dur);
    // gathered wood pile
    const sticks = Math.min(5, Math.floor(p / 0.07));
    ctx.save(); ctx.lineCap = 'round';
    for (let i = 0; i < sticks; i++) {
      const sx = SHELTER.cx - 70 + i * 30, sy = SHELTER.bottom - 6 - (i % 2) * 6;
      ctx.strokeStyle = '#262626'; ctx.lineWidth = 11; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + 46, sy - 8); ctx.stroke();
      ctx.strokeStyle = i % 2 ? '#c08a5a' : '#a8643a'; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + 46, sy - 8); ctx.stroke();
    }
    ctx.restore();
    // assembly: the frame rises from the ground up
    const rise = ease((p - 0.35) / 0.5);
    if (rise > 0) {
      ctx.save(); ctx.globalAlpha = 0.9;
      const shown = h * rise;
      ctx.drawImage(img, 0, img.height * (1 - rise), img.width, img.height * rise, x, y + h - shown, w, shown);
      ctx.restore();
    }
  }

  private drawMarker(x: number, y: number) {
    const ctx = this.ctx;
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(0, 0, 26, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#262626'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -46); ctx.stroke();
    ctx.fillStyle = '#ff7a2a'; ctx.beginPath(); ctx.moveTo(2, -46); ctx.lineTo(30, -38); ctx.lineTo(2, -30); ctx.closePath(); ctx.fill(); ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  }

  private heldBy(w: Who): Partial<Record<Side, Held>> {
    const items = this.shown.holdings[w] ?? [];
    const props = items.filter((i) => !i.startsWith('bottle'));
    const bottles = items.filter((i) => i.startsWith('bottle'));
    const owner: Record<string, Who> = { toolkit: 'A', rope: 'B', first_aid_kit: 'C' };
    const out: Partial<Record<Side, Held>> = {};
    if (props[0]) out.l = { kind: 'prop', owner: owner[props[0]] };
    if (bottles[0]) out.r = { kind: 'bottle' };
    else if (props[1]) out.r = { kind: 'prop', owner: owner[props[1]] };
    return out;
  }

  private drawRadio() {
    const ctx = this.ctx, [x, y] = RADIO, on = this.shown.radioWorking;
    ctx.save(); ctx.translate(x, y);
    ctx.lineJoin = 'round'; ctx.strokeStyle = '#262626'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(18, -22); ctx.lineTo(30, -58); ctx.stroke();
    ctx.fillStyle = '#7b8088'; roundRect(ctx, -34, -26, 68, 40, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#4a4e55'; roundRect(ctx, -2, -18, 28, 22, 4); ctx.fill();
    ctx.fillStyle = '#262626'; for (let i = 0; i < 3; i++) ctx.fillRect(2, -14 + i * 7, 20, 3);
    if (on) { ctx.fillStyle = 'rgba(80,255,120,0.35)'; ctx.beginPath(); ctx.arc(-18, -6, 14 + 2 * Math.sin(performance.now() / 160), 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = on ? '#4ef07a' : '#5a1f1f'; ctx.beginPath(); ctx.arc(-18, -6, 7, 0, Math.PI * 2); ctx.fill(); ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  }

  private drawCallouts() {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = 'bold 22px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.fillStyle = '#ffe38a';
    const label = (t: string, x: number, y: number) => { ctx.strokeText(t, x, y); ctx.fillText(t, x, y); };
    label('damaged radio', RADIO[0], RADIO[1] + 50);
    label('two water bottles', BOTTLE_AT.wreckage[0] + 12, BOTTLE_AT.wreckage[1] + 42);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 19px -apple-system, sans-serif';
    for (const c of Object.values(this.chars)) label(NAMES[c.who], c.x, c.y + 30);
    ctx.restore();
  }

  private publishDebug() {
    const b = this.boatRect();
    (window as any).__stage = {
      phase: this.phase, turn: this.turnIndex >= 0 && this.turnIndex < this.record.turns.length ? this.record.turns[this.turnIndex].turn : null,
      turnsInRecord: this.record.turns.length,
      radioWorking: this.shown.radioWorking, speaker: this.speaker?.who ?? null, voicesPlaying: this.sources.length, storm: this.storm,
      holdings: this.shown.holdings,
      shelter: { built: !!this.shown.shelterBuilt, building: !!this.build },
      boat: { visible: this.boat.visible, x: Math.round(b.x), bottomOverWater: !this.isDry(b.x + b.w * 0.5, b.y + b.h * 0.9) },
      markers: this.markers,
      chars: Object.fromEntries(Object.values(this.chars).map((c) => [c.who, {
        x: Math.round(c.x), y: Math.round(c.y), spot: c.spot, facing: c.facing, walking: c.walking, mouth: c.mouth,
        gesture: c.gesture?.kind ?? (c.stumble ? 'stumble' : null), alpha: +c.alpha.toFixed(2), deck: c.deck, final: c.final,
        onDrySand: c.deck !== null ? null : this.isDry(c.x, c.y),
        thigh_l: +c.pose.thigh_l.toFixed(1), thigh_r: +c.pose.thigh_r.toFixed(1), knee_l: +c.pose.knee_l.toFixed(1),
        shoulder_l: +c.pose.shoulder_l.toFixed(1), shoulder_r: +c.pose.shoulder_r.toFixed(1),
      }])),
    };
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/** Water bottle in the sheet's style (thick dark outline). Drawn with its top at y=0. */
export function drawBottle(ctx: CanvasRenderingContext2D, h: number) {
  const w = h * 0.42;
  ctx.save();
  ctx.lineJoin = 'round'; ctx.strokeStyle = '#262626'; ctx.lineWidth = Math.max(2, h * 0.08);
  ctx.fillStyle = '#9fd3f5'; roundRect(ctx, -w / 2, h * 0.22, w, h * 0.78, w * 0.25); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#2b6a92'; roundRect(ctx, -w * 0.28, 0, w * 0.56, h * 0.24, w * 0.1); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(-w * 0.25, h * 0.36, w * 0.14, h * 0.45);
  ctx.restore();
}
