// Cutout-rig loader and renderer. Parts, pivots and sockets come from public/rig/rig.json
// (written by stage/slice-rig.py from the cutout sheet), so the same rig math is used
// for the preview and the stage.
import { url } from './url';
export type Who = 'A' | 'B' | 'C';
export type Side = 'l' | 'r';
export type MouthShape = 'closed' | 'open' | 'wide';

interface PartInfo { src: string; w: number; h: number }
interface JointInfo { pivot?: [number, number]; sockets?: Record<string, [number, number]> }
interface RigJson { joints: Record<string, JointInfo>; characters: Record<Who, Record<string, PartInfo>> }

export interface Pose {
  thigh_l: number; thigh_r: number; knee_l: number; knee_r: number;       // degrees; + rotates the limb's lower end backward (when facing right)
  shoulder_l: number; shoulder_r: number; elbow_l: number; elbow_r: number;
  head: number;
  bodyY: number;   // vertical offset of the whole body, in part pixels (+ = down)
  lean: number;    // whole-body rotation around the feet, degrees
}
export const REST: Pose = { thigh_l: 0, thigh_r: 0, knee_l: 0, knee_r: 0, shoulder_l: 6, shoulder_r: -6, elbow_l: -4, elbow_r: 4, head: 0, bodyY: 0, lean: 0 };

/** Something drawn in a hand: a sheet prop image or a drawn bottle. */
export type Held = { kind: 'prop'; owner: Who } | { kind: 'bottle' };

export interface Rig {
  json: RigJson;
  img: Record<Who, Record<string, HTMLImageElement>>;
  feetY: Record<Who, number>;     // distance from torso top to the feet line, part pixels
  height: Record<Who, number>;    // rest height (feet → top of head), part pixels
}

const loadImg = (src: string) => new Promise<HTMLImageElement>((ok, fail) => {
  const im = new Image();
  im.onload = () => ok(im);
  im.onerror = () => fail(new Error(`failed to load ${src}`));
  im.src = src;
});

export async function loadRig(): Promise<Rig> {
  const json: RigJson = await (await fetch(url('/rig/rig.json'))).json();
  const img = { A: {}, B: {}, C: {} } as Rig['img'];
  await Promise.all((Object.keys(json.characters) as Who[]).flatMap((w) =>
    Object.entries(json.characters[w]).map(async ([name, p]) => { img[w][name] = await loadImg(url(p.src)); })));
  const feetY = {} as Rig['feetY'];
  const height = {} as Rig['height'];
  for (const w of Object.keys(json.characters) as Who[]) {
    const c = json.characters[w], J = json.joints;
    const leg = (s: Side) => J.torso.sockets![`hip_${s}`][1] * c.torso.h
      + (J.thigh.sockets!.knee[1] - J.thigh.pivot![1]) * c[`thigh_${s}`].h
      + (J.lower_leg.sockets!.foot[1] - J.lower_leg.pivot![1]) * c[`lower_leg_${s}`].h;
    feetY[w] = (leg('l') + leg('r')) / 2;
    const headTop = J.torso.sockets!.neck[1] * c.torso.h - J.head.pivot![1] * c.head.h;
    height[w] = feetY[w] - headTop;
  }
  return { json, img, feetY, height };
}

const rad = (d: number) => (d * Math.PI) / 180;

/**
 * Draw one character. (x, y) is the point between the feet in stage pixels; `scale` maps
 * part pixels → stage pixels; `facing` is +1 (right) or -1 (left).
 */
export function drawCharacter(
  ctx: CanvasRenderingContext2D, rig: Rig, who: Who, x: number, y: number, scale: number, facing: number,
  pose: Pose, mouth: MouthShape, held: Partial<Record<Side, Held>>, drawBottle: (ctx: CanvasRenderingContext2D, height: number) => void,
) {
  const c = rig.json.characters[who], J = rig.json.joints, I = rig.img[who];
  const part = (name: string, kind: string) => {
    const p = c[name], pv = J[kind].pivot ?? [0, 0];
    ctx.drawImage(I[name], -pv[0] * p.w, -pv[1] * p.h, p.w, p.h);
  };
  const socket = (name: string, kind: string, s: string) => {
    const p = c[name], pv = J[kind].pivot ?? [0, 0], f = J[kind].sockets![s];
    return [(f[0] - pv[0]) * p.w, (f[1] - pv[1]) * p.h] as const;
  };
  const torsoSock = (s: string) => {
    const f = J.torso.sockets![s];
    return [(f[0] - 0.5) * c.torso.w, f[1] * c.torso.h - rig.feetY[who]] as const;
  };

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale * facing, scale);
  ctx.rotate(rad(pose.lean));
  ctx.translate(0, pose.bodyY);

  // legs: lower leg first so the thigh's rounded end covers the knee
  for (const s of ['l', 'r'] as Side[]) {
    const [hx, hy] = torsoSock(`hip_${s}`);
    ctx.save();
    ctx.translate(hx, hy); ctx.rotate(rad(pose[`thigh_${s}`]));
    const [kx, ky] = socket(`thigh_${s}`, 'thigh', 'knee');
    ctx.save(); ctx.translate(kx, ky); ctx.rotate(rad(pose[`knee_${s}`])); part(`lower_leg_${s}`, 'lower_leg'); ctx.restore();
    part(`thigh_${s}`, 'thigh');
    ctx.restore();
  }
  // torso (positioned so the rest-pose feet sit on y = 0)
  ctx.drawImage(I.torso, -c.torso.w / 2, -rig.feetY[who], c.torso.w, c.torso.h);
  // arms: forearm (and anything held) first so the sleeve cuff covers the elbow
  for (const s of ['l', 'r'] as Side[]) {
    const [sx, sy] = torsoSock(`shoulder_${s}`);
    ctx.save();
    ctx.translate(sx, sy); ctx.rotate(rad(pose[`shoulder_${s}`]));
    const [ex, ey] = socket(`upper_arm_${s}`, 'upper_arm', 'elbow');
    ctx.save();
    ctx.translate(ex, ey); ctx.rotate(rad(pose[`elbow_${s}`]));
    const h = held[s];
    if (h) {
      const [hx, hy] = socket(`forearm_${s}`, 'forearm', 'hand');
      ctx.save(); ctx.translate(hx, hy); ctx.rotate(rad(-pose[`elbow_${s}`] - pose[`shoulder_${s}`] - pose.lean)); // items hang straight down
      if (h.kind === 'prop') {
        const p = rig.json.characters[h.owner].prop, pv = J.prop.pivot!, k = 0.62;
        ctx.drawImage(rig.img[h.owner].prop, -pv[0] * p.w * k, -pv[1] * p.h * k, p.w * k, p.h * k);
      } else drawBottle(ctx, 95); // hangs from the hand, top at the grip
      ctx.restore();
    }
    part(`forearm_${s}`, 'forearm');
    ctx.restore();
    part(`upper_arm_${s}`, 'upper_arm');
    ctx.restore();
  }
  // head + mouth (the mouth swaps shape on a fixed point; the head itself stays still)
  const [nx, ny] = torsoSock('neck');
  ctx.save();
  ctx.translate(nx, ny); ctx.rotate(rad(pose.head));
  part('head', 'head');
  const [mx, my] = socket('head', 'head', 'mouth');
  ctx.translate(mx, my);
  part(`mouth_${mouth}`, 'mouth');
  ctx.restore();

  ctx.restore();
}
