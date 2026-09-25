/**
 * Stickman action engine — pure code, shared by the cloud runner (which needs
 * the exact impact times for the sound effects) and the stage (which draws).
 *
 *  - A skeleton (hip, torso, head, two arms, two legs) posed by joint angles.
 *  - An action library (run, dash, blink, punch, flurry, heavy punch, ground
 *    slam, energy blast, beam, kick, block, dodge, flips, knockdowns…), each a
 *    timed sequence of key poses with root motion, impact moments, damage and
 *    a sound.
 *  - A choreographer that turns beats ("A punches B", "B blocks") into a
 *    timeline: attackers close the distance first (fighters with speed dash),
 *    targets react at the moment of impact (flinch, block, fly back, fall, or
 *    stay down for a knockout), area attacks hit everyone nearby, energy
 *    attacks travel as projectiles.
 *  - A fight planner for "VS" fight edits: two sides (speed vs strength, a
 *    king vs an army, an engineer vs AI coding agents…) with archetypes, fought
 *    over rounds whose winners the script decides; it writes the beats.
 *
 * Angles are degrees. Limbs: 0 = hanging straight down, 90 = pointing forward
 * (the way the figure faces), 180 = straight up. Elbows/knees: bend in degrees.
 */

export interface Pose {
  lean: number;      // torso: + leans forward
  head: number;      // head tilt relative to torso
  aF: number; eF: number; // front arm: shoulder, elbow
  aB: number; eB: number; // back arm
  lF: number; kF: number; // front leg: hip, knee
  lB: number; kB: number; // back leg
  y: number;         // root lift (units, + = up)
  rot: number;       // whole-body rotation (flips, falls), degrees
}

const P = (lean: number, head: number, aF: number, eF: number, aB: number, eB: number, lF: number, kF: number, lB: number, kB: number, y = 0, rot = 0): Pose => ({ lean, head, aF, eF, aB, eB, lF, kF, lB, kB, y, rot });

/** Key poses. */
export const POSES: Record<string, Pose> = {
  stand: P(0, 0, 8, 10, -8, 10, 4, 4, -4, 4),
  guard: P(8, -4, 70, 110, 40, 120, 22, 18, -18, 22, -5),
  guardB: P(11, -3, 64, 118, 46, 114, 24, 22, -20, 24, -11),
  run1: P(18, -6, 70, 90, -50, 80, 55, 70, -30, 20),
  run2: P(18, -6, -45, 80, 65, 90, -25, 25, 60, 80),
  dash1: P(42, -14, -70, 20, -80, 20, 60, 80, -45, 30, -6),
  dash2: P(42, -14, -75, 20, -70, 20, -35, 30, 55, 90, -6),
  walk1: P(6, -2, 30, 40, -25, 30, 26, 10, -20, 18),
  walk2: P(6, -2, -25, 30, 30, 40, -20, 18, 26, 10),
  crouch: P(20, -8, 30, 60, -20, 60, 70, 110, 10, 110, -22),
  air: P(10, -6, 150, 20, 140, 20, 60, 90, -10, 100, 0),
  punchWind: P(-4, 0, 60, 120, 10, 140, 26, 20, -20, 20, -4),
  punch: P(22, -6, 92, 0, 40, 120, 30, 14, -34, 14, -8),
  jab: P(16, -4, 40, 120, 92, 0, 28, 16, -30, 16, -6),
  heavyWind: P(-22, 6, -50, 90, 70, 110, 34, 30, -26, 16, -8),
  heavyPunch: P(34, -10, 94, 0, -40, 50, 44, 26, -42, 6, -12),
  kickChamber: P(-10, 4, 60, 110, -30, 60, 95, 110, -8, 8, 0),
  kick: P(-22, 8, 50, 100, -40, 50, 92, 0, -10, 6, 4),
  highKick: P(-35, 12, 40, 100, -60, 40, 140, 0, -8, 6, 6),
  uppercutLow: P(26, -10, 20, 150, 40, 120, 60, 90, -20, 60, -18),
  uppercut: P(-6, -12, 170, 20, 30, 130, 20, 10, -24, 20, 10),
  slamAir: P(-12, -12, 172, 10, 165, 10, 40, 80, -20, 90),
  slamDown: P(46, -12, 118, 10, 104, 10, 75, 115, -12, 115, -34),
  charge: P(-6, 4, 60, 150, 50, 150, 30, 30, -30, 30, -8),
  push: P(16, -4, 96, 0, 88, 12, 34, 22, -34, 18, -6),
  block: P(4, 6, 115, 150, 100, 150, 20, 20, -22, 22, -4),
  hit: P(-26, 22, -20, 30, -40, 30, 10, 20, -30, 30),
  hitHard: P(-40, 30, 120, 20, 100, 20, 40, 30, -10, 40, 8),
  down: P(-90, 10, 170, 10, 150, 20, 10, 20, -10, 30, -46, 0),
  getup: P(40, -10, 40, 60, -30, 60, 80, 100, -20, 90, -30),
  dodge: P(-34, 10, 60, 120, 20, 120, 30, 30, -30, 40, -2),
  duck: P(30, -10, 60, 120, 40, 120, 80, 120, -10, 120, -40),
  slashWind: P(-6, 0, 170, 30, 60, 90, 24, 18, -22, 20, -4),
  slash: P(26, -6, 60, 0, 30, 110, 32, 16, -34, 16, -8),
  taunt: P(-4, -6, 100, 60, 10, 20, 10, 8, -10, 8),
  taunt2: P(-4, -6, 100, 20, 10, 20, 10, 8, -10, 8),
  flex: P(-2, -8, 150, 140, 150, 140, 18, 6, -18, 6),
  victory: P(-4, -12, 170, 10, 165, 10, 8, 6, -8, 6, 2),
  slide: P(-30, 10, 60, 40, -20, 40, 90, 0, 40, 120, -40),
  flipTuck: P(30, -10, 90, 140, 80, 140, 110, 140, 100, 140, 30),
};

export interface Key { pose: string; at: number } // at: seconds from action start
export interface ActionDef {
  keys: Key[];
  /** Total length (s). */
  dur: number;
  /** Seconds from start when the (last) blow lands (attacks). */
  impact?: number;
  /** Several blows (seconds from start); the last one is `impact`. */
  hits?: number[];
  /** Forward root travel over the action (units, in the facing direction). */
  travel?: number;
  /** Jump arc height (units). */
  arc?: number;
  /** Extra whole-body spin over the action (degrees). */
  spin?: number;
  /** How far an attacker must be from its target. */
  reach?: number;
  /** Target's reaction. */
  effect?: 'hit' | 'launch' | 'launchFar' | 'down';
  /** Everyone of the other side within this distance of the landing point is hit. */
  aoe?: number;
  /** A travelling energy attack. */
  projectile?: 'orb' | 'beam';
  /** Damage (per blow for multi-hit moves). */
  dmg?: number;
  /** Effect size: bigger shake, flash, debris. */
  power?: number;
  /** Ground impact: rubble and dust. */
  ground?: boolean;
  sfx?: string;
  /** Sound of each extra blow of a multi-hit move. */
  hitSfx?: string;
  /** Loops (run / walk / dash): keys repeat every `dur`. */
  loop?: boolean;
}

export const ACTIONS: Record<string, ActionDef> = {
  idle: { keys: [{ pose: 'guard', at: 0 }, { pose: 'guardB', at: 0.28 }, { pose: 'guard', at: 0.56 }], dur: 0.56, loop: true },
  stand: { keys: [{ pose: 'stand', at: 0 }], dur: 1, loop: true },
  run: { keys: [{ pose: 'run1', at: 0 }, { pose: 'run2', at: 0.17 }, { pose: 'run1', at: 0.34 }], dur: 0.34, loop: true },
  dash: { keys: [{ pose: 'dash1', at: 0 }, { pose: 'dash2', at: 0.08 }, { pose: 'dash1', at: 0.16 }], dur: 0.16, loop: true, sfx: 'dash' },
  walk: { keys: [{ pose: 'walk1', at: 0 }, { pose: 'walk2', at: 0.45 }, { pose: 'walk1', at: 0.9 }], dur: 0.9, loop: true },
  jump: { keys: [{ pose: 'crouch', at: 0 }, { pose: 'air', at: 0.22 }, { pose: 'air', at: 0.6 }, { pose: 'crouch', at: 0.78 }, { pose: 'guard', at: 1.0 }], dur: 1.0, arc: 120, travel: 60, sfx: 'whoosh' },
  punch: { keys: [{ pose: 'guard', at: 0 }, { pose: 'punchWind', at: 0.12 }, { pose: 'punch', at: 0.22 }, { pose: 'punch', at: 0.34 }, { pose: 'guard', at: 0.6 }], dur: 0.6, impact: 0.22, travel: 14, reach: 88, effect: 'hit', dmg: 8, sfx: 'punch' },
  jab: { keys: [{ pose: 'guard', at: 0 }, { pose: 'jab', at: 0.1 }, { pose: 'guard', at: 0.32 }], dur: 0.32, impact: 0.1, travel: 6, reach: 84, effect: 'hit', dmg: 4, sfx: 'jab' },
  combo: { keys: [{ pose: 'guard', at: 0 }, { pose: 'jab', at: 0.1 }, { pose: 'guard', at: 0.24 }, { pose: 'punchWind', at: 0.32 }, { pose: 'punch', at: 0.42 }, { pose: 'guard', at: 0.7 }], dur: 0.7, impact: 0.42, hits: [0.1, 0.42], travel: 20, reach: 88, effect: 'hit', dmg: 6, sfx: 'punch', hitSfx: 'jab' },
  flurry: {
    keys: [{ pose: 'guard', at: 0 }, { pose: 'jab', at: 0.07 }, { pose: 'punch', at: 0.15 }, { pose: 'jab', at: 0.23 }, { pose: 'punch', at: 0.31 }, { pose: 'jab', at: 0.39 }, { pose: 'punch', at: 0.47 }, { pose: 'punchWind', at: 0.56 }, { pose: 'heavyPunch', at: 0.66 }, { pose: 'heavyPunch', at: 0.8 }, { pose: 'guard', at: 1.0 }],
    dur: 1.0, hits: [0.07, 0.15, 0.23, 0.31, 0.39, 0.47, 0.66], impact: 0.66, travel: 60, reach: 90, effect: 'launch', dmg: 3, power: 1.1, sfx: 'punch', hitSfx: 'jab',
  },
  heavyPunch: { keys: [{ pose: 'guard', at: 0 }, { pose: 'heavyWind', at: 0.36 }, { pose: 'heavyPunch', at: 0.48 }, { pose: 'heavyPunch', at: 0.72 }, { pose: 'guard', at: 1.05 }], dur: 1.05, impact: 0.48, travel: 30, reach: 102, effect: 'launchFar', dmg: 24, power: 1.6, sfx: 'heavy' },
  slam: { keys: [{ pose: 'crouch', at: 0 }, { pose: 'slamAir', at: 0.3 }, { pose: 'slamAir', at: 0.46 }, { pose: 'slamDown', at: 0.62 }, { pose: 'slamDown', at: 0.92 }, { pose: 'guard', at: 1.2 }], dur: 1.2, impact: 0.62, travel: 90, arc: 170, reach: 138, aoe: 280, effect: 'down', dmg: 22, power: 1.8, ground: true, sfx: 'boom' },
  blast: { keys: [{ pose: 'guard', at: 0 }, { pose: 'charge', at: 0.22 }, { pose: 'push', at: 0.32 }, { pose: 'push', at: 0.6 }, { pose: 'guard', at: 0.85 }], dur: 0.85, impact: 0.32, reach: 1500, projectile: 'orb', effect: 'launch', dmg: 14, power: 1.2, sfx: 'zap' },
  beam: { keys: [{ pose: 'guard', at: 0 }, { pose: 'charge', at: 0.45 }, { pose: 'push', at: 0.55 }, { pose: 'push', at: 1.05 }, { pose: 'guard', at: 1.3 }], dur: 1.3, impact: 0.6, reach: 1700, projectile: 'beam', effect: 'launchFar', dmg: 26, power: 1.7, sfx: 'beam' },
  blink: { keys: [{ pose: 'guard', at: 0 }, { pose: 'crouch', at: 0.07 }, { pose: 'guard', at: 0.26 }], dur: 0.26, sfx: 'blink' },
  kick: { keys: [{ pose: 'guard', at: 0 }, { pose: 'kickChamber', at: 0.14 }, { pose: 'kick', at: 0.26 }, { pose: 'kick', at: 0.4 }, { pose: 'guard', at: 0.66 }], dur: 0.66, impact: 0.26, travel: 10, reach: 114, effect: 'launch', dmg: 10, sfx: 'kick' },
  roundhouse: { keys: [{ pose: 'guard', at: 0 }, { pose: 'kickChamber', at: 0.16 }, { pose: 'highKick', at: 0.3 }, { pose: 'highKick', at: 0.44 }, { pose: 'guard', at: 0.74 }], dur: 0.74, impact: 0.3, travel: 10, reach: 118, spin: 0, effect: 'down', dmg: 16, power: 1.3, sfx: 'kick' },
  uppercut: { keys: [{ pose: 'guard', at: 0 }, { pose: 'uppercutLow', at: 0.16 }, { pose: 'uppercut', at: 0.28 }, { pose: 'uppercut', at: 0.42 }, { pose: 'guard', at: 0.7 }], dur: 0.7, impact: 0.28, travel: 18, reach: 82, effect: 'launch', dmg: 14, power: 1.2, sfx: 'punch' },
  flyingKick: { keys: [{ pose: 'crouch', at: 0 }, { pose: 'kickChamber', at: 0.2 }, { pose: 'kick', at: 0.42 }, { pose: 'kick', at: 0.62 }, { pose: 'crouch', at: 0.8 }, { pose: 'guard', at: 1.0 }], dur: 1.0, impact: 0.46, travel: 170, arc: 70, reach: 210, effect: 'down', dmg: 16, power: 1.3, sfx: 'kick' },
  slash: { keys: [{ pose: 'guard', at: 0 }, { pose: 'slashWind', at: 0.16 }, { pose: 'slash', at: 0.28 }, { pose: 'slash', at: 0.42 }, { pose: 'guard', at: 0.7 }], dur: 0.7, impact: 0.28, travel: 20, reach: 128, effect: 'launch', dmg: 16, sfx: 'slash' },
  dashSlash: { keys: [{ pose: 'slashWind', at: 0 }, { pose: 'slash', at: 0.14 }, { pose: 'slash', at: 0.4 }, { pose: 'guard', at: 0.62 }], dur: 0.62, impact: 0.14, travel: 380, reach: 200, effect: 'down', dmg: 20, power: 1.4, sfx: 'slash' },
  block: { keys: [{ pose: 'guard', at: 0 }, { pose: 'block', at: 0.08 }, { pose: 'block', at: 0.45 }, { pose: 'guard', at: 0.6 }], dur: 0.6, travel: -10, sfx: 'block' },
  dodge: { keys: [{ pose: 'guard', at: 0 }, { pose: 'dodge', at: 0.12 }, { pose: 'dodge', at: 0.35 }, { pose: 'guard', at: 0.55 }], dur: 0.55, travel: -40, sfx: 'whoosh' },
  duck: { keys: [{ pose: 'guard', at: 0 }, { pose: 'duck', at: 0.1 }, { pose: 'duck', at: 0.36 }, { pose: 'guard', at: 0.55 }], dur: 0.55, sfx: 'whoosh' },
  backflip: { keys: [{ pose: 'crouch', at: 0 }, { pose: 'flipTuck', at: 0.22 }, { pose: 'flipTuck', at: 0.62 }, { pose: 'crouch', at: 0.8 }, { pose: 'guard', at: 1.0 }], dur: 1.0, arc: 110, travel: -120, spin: -360, sfx: 'whoosh' },
  frontflip: { keys: [{ pose: 'crouch', at: 0 }, { pose: 'flipTuck', at: 0.22 }, { pose: 'flipTuck', at: 0.62 }, { pose: 'crouch', at: 0.8 }, { pose: 'guard', at: 1.0 }], dur: 1.0, arc: 110, travel: 140, spin: 360, sfx: 'whoosh' },
  slide: { keys: [{ pose: 'run1', at: 0 }, { pose: 'slide', at: 0.12 }, { pose: 'slide', at: 0.5 }, { pose: 'guard', at: 0.75 }], dur: 0.75, travel: 170, sfx: 'slide' },
  taunt: { keys: [{ pose: 'taunt', at: 0 }, { pose: 'taunt2', at: 0.25 }, { pose: 'taunt', at: 0.5 }, { pose: 'taunt2', at: 0.75 }, { pose: 'guard', at: 1.1 }], dur: 1.1 },
  flex: { keys: [{ pose: 'guard', at: 0 }, { pose: 'flex', at: 0.25 }, { pose: 'flex', at: 1.0 }, { pose: 'guard', at: 1.25 }], dur: 1.25 },
  victory: { keys: [{ pose: 'guard', at: 0 }, { pose: 'victory', at: 0.3 }, { pose: 'victory', at: 1.6 }], dur: 1.6 },
  // Reactions (started by the choreographer at the moment of impact).
  hit: { keys: [{ pose: 'hit', at: 0 }, { pose: 'hit', at: 0.16 }, { pose: 'guard', at: 0.45 }], dur: 0.45, travel: -34, sfx: '' },
  stagger: { keys: [{ pose: 'hit', at: 0 }, { pose: 'hitHard', at: 0.08 }, { pose: 'hit', at: 0.16 }], dur: 0.16, loop: true },
  launch: { keys: [{ pose: 'hitHard', at: 0 }, { pose: 'hitHard', at: 0.35 }, { pose: 'crouch', at: 0.6 }, { pose: 'guard', at: 0.85 }], dur: 0.85, travel: -170, arc: 50, sfx: 'thud' },
  launchFar: { keys: [{ pose: 'hitHard', at: 0 }, { pose: 'hitHard', at: 0.5 }, { pose: 'down', at: 0.75 }, { pose: 'down', at: 1.1 }], dur: 1.1, travel: -520, arc: 110, spin: -200, sfx: 'thud' },
  down: { keys: [{ pose: 'hitHard', at: 0 }, { pose: 'down', at: 0.35 }, { pose: 'down', at: 0.9 }], dur: 0.9, travel: -150, arc: 40, sfx: 'thud' },
  getup: { keys: [{ pose: 'down', at: 0 }, { pose: 'getup', at: 0.35 }, { pose: 'guard', at: 0.8 }], dur: 0.8 },
};

export const ATTACKS = Object.keys(ACTIONS).filter((k) => ACTIONS[k].impact !== undefined);
export const MOVES = ['run', 'dash', 'jump', 'dodge', 'duck', 'block', 'backflip', 'frontflip', 'slide', 'blink', 'taunt', 'flex', 'victory', 'getup', 'idle', ...ATTACKS];
/** Reactions that end with the fighter on the floor. */
const FLOORED = new Set(['down', 'launchFar']);

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (t: number) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
const snap = (t: number) => { const x = clamp(t, 0, 1); return 1 - (1 - x) * (1 - x) * (1 - x); }; // fast out: strikes snap

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const o: any = {};
  for (const k of Object.keys(a) as (keyof Pose)[]) o[k] = a[k] + (b[k] - a[k]) * t;
  return o;
}

/** Catmull-Rom through four poses (t between p1 and p2). */
export function splinePose(p0: Pose, p1: Pose, p2: Pose, p3: Pose, t: number): Pose {
  const o: any = {};
  const t2 = t * t, t3 = t2 * t;
  for (const k of Object.keys(p1) as (keyof Pose)[]) {
    o[k] = 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
  }
  return o;
}

/** The pose of an action at time `local` (seconds since it started). */
export function poseOf(action: string, local: number): Pose {
  const def = ACTIONS[action] || ACTIONS.idle;
  let t = local;
  if (def.loop) t = ((local % def.dur) + def.dur) % def.dur;
  const keys = def.keys;
  if (t <= keys[0].at) return POSES[keys[0].pose];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].at) {
      const a = keys[i - 1], b = keys[i];
      const k = (t - a.at) / Math.max(1e-3, b.at - a.at);
      const strike = def.impact !== undefined && (Math.abs(b.at - def.impact) < 0.01 || (def.hits || []).some((h) => Math.abs(b.at - h) < 0.01));
      if (strike) return lerpPose(POSES[a.pose], POSES[b.pose], snap(k));
      // Everything else flows through the keys (a spline, not stop-start), with a little follow-through.
      const p0 = POSES[(keys[i - 2] || (def.loop ? keys[keys.length - 2] : a) || a).pose], p3 = POSES[(keys[i + 1] || (def.loop ? keys[1] : b) || b).pose];
      return splinePose(p0, POSES[a.pose], POSES[b.pose], p3, ease(k) * 0.35 + k * 0.65);
    }
  }
  return POSES[keys[keys.length - 1].pose];
}

// ---------------------------------------------------------------------------
// Choreography
// ---------------------------------------------------------------------------
export interface Beat { actor: string; action: string; target?: string; line?: string; /** The blow ends the round for the target: down and out. */ ko?: boolean; /** Slow motion (time stretch) for a finisher. */ slow?: number }
export interface Fighter {
  id: string; name: string; color: string; weapon?: 'none' | 'sword' | 'staff'; x: number;
  /** Fighters on the same team never hit each other (default: everyone is their own team). */
  team?: string;
  /** How the fighter closes the distance. */
  approach?: 'run' | 'dash' | 'walk';
}
export interface Clip { start: number; end: number; action: string; x0: number; x1: number; facing: 1 | -1; arc: number; spin: number }
export interface ImpactFx { t: number; x: number; y: number; kind: string; strength: number; target?: string; attacker?: string; dmg?: number; ko?: boolean; ground?: boolean; move?: string }
export interface Sfx { t: number; kind: string }
export interface Line { t: number; end: number; actor: string; text: string }
export interface Projectile { t0: number; t1: number; x0: number; x1: number; y: number; kind: 'orb' | 'beam'; owner: string }
export interface Focus { t: number; a: string; b?: string }
export interface Choreo { duration: number; clips: Record<string, Clip[]>; impacts: ImpactFx[]; sfx: Sfx[]; lines: Line[]; projectiles?: Projectile[]; focus?: Focus[]; ko?: string[]; slowmo?: { t0: number; t1: number }[] }

const SPEED: Record<string, number> = { run: 520, dash: 2600, walk: 230 };
const ORB_SPEED = 1900;

/**
 * Lays the beats out in time. `lineDur` gives the spoken length of a beat's
 * line (the choreographer waits for it before the next beat).
 */
export function choreograph(fighters: Fighter[], beats: Beat[], opts: { start?: number; minDuration?: number; lineDur?: (text: string) => number } = {}): Choreo {
  const t0 = opts.start || 0;
  const clips: Record<string, Clip[]> = {};
  const pos: Record<string, number> = {};
  const face: Record<string, 1 | -1> = {};
  const busyUntil: Record<string, number> = {};
  const downed: Record<string, boolean> = {};
  const out: Record<string, boolean> = {};
  for (const f of fighters) { clips[f.id] = []; pos[f.id] = f.x; busyUntil[f.id] = t0; downed[f.id] = false; out[f.id] = false; }
  const teamOf = (id: string) => fighters.find((f) => f.id === id)?.team || id;
  const enemies = (id: string) => fighters.filter((f) => f.id !== id && teamOf(f.id) !== teamOf(id) && !out[f.id]);
  const nearest = (id: string) => enemies(id).sort((a, b) => Math.abs(pos[a.id] - pos[id]) - Math.abs(pos[b.id] - pos[id]))[0];
  const faceNearest = (id: string) => { const n = nearest(id); if (n) face[id] = pos[n.id] < pos[id] ? -1 : 1; };
  fighters.forEach((f) => faceNearest(f.id));
  const impacts: ImpactFx[] = [], sfx: Sfx[] = [], lines: Line[] = [], projectiles: Projectile[] = [], focus: Focus[] = [];
  let slowK = 1; // time stretch of the beat being laid out (slow-motion finishers)
  const slowmo: { t0: number; t1: number }[] = [];
  const add = (id: string, action: string, start: number, dur: number, x1?: number) => {
    const k = slowK;
    const def = ACTIONS[action] || ACTIONS.idle;
    const x0 = pos[id];
    const to = x1 ?? x0 + (def.travel || 0) * face[id];
    clips[id].push({ start, end: start + dur, action, x0, x1: to, facing: face[id], arc: def.arc || 0, spin: (def.spin || 0) * face[id] });
    pos[id] = to;
    busyUntil[id] = start + dur;
    if (def.hits && def.hits.length > 1) {
      for (const h of def.hits.slice(0, -1)) sfx.push({ t: start + h * k, kind: def.hitSfx || 'jab' });
      sfx.push({ t: start + def.impact! * k, kind: def.sfx || 'punch' });
    } else if (def.sfx) sfx.push({ t: start + (def.sfx === 'dash' ? 0 : (def.impact ?? 0.04) * k), kind: def.sfx });
  };
  /** A blow interrupts whatever the target was doing. */
  const interrupt = (id: string, at: number) => {
    const list = clips[id];
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (c.start >= at) { list.splice(i, 1); continue; }
      if (c.end > at) {
        const k = (at - c.start) / (c.end - c.start);
        c.x1 = c.x0 + (c.x1 - c.x0) * k;
        c.end = at;
        c.arc = 0; c.spin = 0;
      }
      pos[id] = c.x1;
      break;
    }
    busyUntil[id] = Math.min(busyUntil[id], at);
  };
  /** A target takes a blow at `at`. */
  const takeHit = (actorId: string, targetId: string, at: number, A: ActionDef, move: string, ko: boolean, dmgScale = 1) => {
    interrupt(targetId, at);
    face[targetId] = pos[actorId] < pos[targetId] ? -1 : 1;
    let r: string = ko ? (A.effect === 'launchFar' ? 'launchFar' : 'down') : A.effect || 'hit';
    const hitX = pos[targetId];
    add(targetId, r, at, ACTIONS[r].dur * slowK);
    if (FLOORED.has(r)) downed[targetId] = true;
    if (ko) out[targetId] = true;
    const high = move === 'uppercut' || move === 'roundhouse' ? 150 : move === 'kick' || move === 'flyingKick' ? 105 : A.ground ? 20 : 128;
    impacts.push({ t: at, x: hitX, y: high, kind: r, strength: (r === 'hit' ? 0.6 : 1) * (A.power || 1), target: targetId, attacker: actorId, dmg: (A.dmg || 8) * dmgScale, ko, ground: !!A.ground, move });
  };
  const skip = new Set<number>();
  let t = t0;
  beats.forEach((b, bi) => {
    if (skip.has(bi)) return;
    const actor = fighters.find((f) => f.id === b.actor);
    if (!actor || out[actor.id]) return;
    const def = ACTIONS[b.action] ? b.action : 'idle';
    slowK = b.slow && b.slow > 1 ? b.slow : 1;
    const A0 = ACTIONS[def];
    const A: ActionDef = slowK === 1 ? A0 : { ...A0, dur: A0.dur * slowK, impact: A0.impact !== undefined ? A0.impact * slowK : undefined, hits: A0.hits?.map((h) => h * slowK) };
    let start = Math.max(t, busyUntil[actor.id]);
    // A fighter who is down gets up first.
    if (downed[actor.id] && def !== 'getup') { add(actor.id, 'getup', start, ACTIONS.getup.dur); start = busyUntil[actor.id]; }
    downed[actor.id] = false;
    let target = b.target ? fighters.find((f) => f.id === b.target && f.id !== actor.id && !out[f.id]) : undefined;
    if (!target && A.impact !== undefined) target = nearest(actor.id);
    if (A.impact !== undefined && !target) return; // nobody left to hit
    if (target) face[actor.id] = pos[target.id] < pos[actor.id] ? -1 : 1; else faceNearest(actor.id);
    focus.push({ t: start, a: actor.id, b: target?.id });
    // Blink: vanish and reappear on the far side of the target.
    if (def === 'blink' && target) {
      const side = pos[target.id] >= pos[actor.id] ? 1 : -1;
      add(actor.id, 'blink', start, A.dur, pos[target.id] + side * 95);
      face[actor.id] = side === 1 ? -1 : 1;
      clips[actor.id][clips[actor.id].length - 1].facing = face[actor.id];
      t = busyUntil[actor.id] - 0.02;
      return;
    }
    // Close the distance before striking (not for energy attacks).
    if (target && A.reach && !A.projectile) {
      const gap = Math.abs(pos[target.id] - pos[actor.id]);
      if (gap > A.reach + 30) {
        const how = actor.approach || 'run';
        const x1 = pos[target.id] - face[actor.id] * A.reach;
        add(actor.id, how, start, Math.max(how === 'dash' ? 0.12 : 0.28, Math.abs(x1 - pos[actor.id]) / SPEED[how]), x1);
        start = busyUntil[actor.id];
      }
    }
    // Spoken line: the fighter says it (taunting, holding a stance) before moving on.
    if (b.line) {
      const d = Math.max(0.9, opts.lineDur ? opts.lineDur(b.line) : b.line.split(/\s+/).length * 0.36) + 0.15;
      lines.push({ t: start, end: start + d, actor: actor.id, text: b.line });
      if (def === 'idle' || def === 'taunt' || def === 'victory' || def === 'flex') {
        add(actor.id, def, start, Math.max(d, A.dur));
        t = busyUntil[actor.id];
        return;
      }
    }
    // Dash-through moves end on the far side of the target.
    let x1: number | undefined;
    if (def === 'dashSlash' && target) x1 = pos[target.id] + face[actor.id] * 180;
    else if (target && A.impact !== undefined && !A.projectile && !A.aoe) {
      // Bodies never overlap: a lunge stops a body-width short of the target.
      const MIN_GAP = 82;
      const natural = pos[actor.id] + (A.travel || 0) * face[actor.id];
      const room = (pos[target.id] - pos[actor.id]) * face[actor.id] - MIN_GAP;
      if ((pos[target.id] - natural) * face[actor.id] < MIN_GAP) x1 = pos[actor.id] + face[actor.id] * Math.max(0, Math.min(A.travel || 0, room));
    }
    add(actor.id, def, start, A.dur, x1);
    if (slowK > 1) slowmo.push({ t0: Math.max(start, start + (A.impact ?? 0) - 0.4 * slowK), t1: start + (A.impact ?? A.dur) + 0.55 * slowK });
    if (def === 'dashSlash') face[actor.id] = face[actor.id] === 1 ? -1 : 1;
    if (target && A.impact !== undefined) {
      let at = start + A.impact;
      if (A.projectile) {
        const from = clips[actor.id][clips[actor.id].length - 1].x0 + face[actor.id] * 50;
        const gap = Math.abs(pos[target.id] - from);
        if (A.projectile === 'orb') at += gap / ORB_SPEED;
        projectiles.push({ t0: start + A.impact, t1: at + (A.projectile === 'beam' ? 0.45 : 0), x0: from, x1: pos[target.id], y: 118, kind: A.projectile, owner: actor.id });
      }
      const nb = beats[bi + 1];
      const defended = !b.ko && nb && nb.actor === target.id && ['block', 'dodge', 'duck', 'backflip'].includes(nb.action) && !A.aoe;
      // Multi-hit: the target staggers through the blows, then takes the last one.
      if (A.hits && A.hits.length > 1 && !defended) {
        const first = start + A.hits[0];
        interrupt(target.id, first);
        face[target.id] = pos[actor.id] < pos[target.id] ? -1 : 1;
        add(target.id, 'stagger', first, at - first, pos[target.id] - face[target.id] * 40);
        for (const h of A.hits.slice(0, -1)) impacts.push({ t: start + h, x: pos[target.id], y: 125 + ((h * 97) % 20), kind: 'hit', strength: 0.45, target: target.id, attacker: actor.id, dmg: A.dmg || 3, move: def });
      }
      if (defended) {
        skip.add(bi + 1);
        interrupt(target.id, at - 0.12);
        face[target.id] = pos[actor.id] < pos[target.id] ? -1 : 1;
        add(target.id, nb.action, at - 0.12, ACTIONS[nb.action].dur);
        if (nb.action === 'block') impacts.push({ t: at, x: (pos[actor.id] + pos[target.id]) / 2, y: 130, kind: 'block', strength: 0.5 * (A.power || 1), target: target.id, attacker: actor.id, dmg: (A.dmg || 8) * 0.2, move: def });
      } else if (A.aoe) {
        const land = pos[actor.id];
        const hitList = enemies(actor.id).filter((f) => Math.abs(pos[f.id] - land) <= A.aoe!);
        if (!hitList.some((f) => f.id === target!.id)) hitList.push(target);
        for (const f of hitList) takeHit(actor.id, f.id, at, A, def, !!b.ko, f.id === target.id ? 1 : 0.8);
        if (A.ground) impacts.push({ t: at, x: land, y: 0, kind: 'ground', strength: A.power || 1.5, attacker: actor.id, ground: true, move: def });
      } else {
        takeHit(actor.id, target.id, at, A, def, !!b.ko);
      }
    }
    // The next beat may start while this move recovers (fights flow).
    t = ['run', 'dash', 'walk'].includes(def) ? busyUntil[actor.id] : start + (A.impact !== undefined ? A.dur * 0.8 : A.dur * 0.9);
  });
  const end = Math.max(t, ...Object.values(busyUntil), t0 + (opts.minDuration || 0)) + 0.5;
  // Fill the gaps: fighting stance (or lying on the floor after a knockdown), facing the nearest opponent.
  for (const f of fighters) {
    const list = clips[f.id].sort((a, b) => a.start - b.start);
    const filled: Clip[] = [];
    let cur = t0, x = f.x, lastAction = '', lastFace: 1 | -1 = face[f.id];
    for (const c of list) {
      if (c.start > cur + 0.005) filled.push({ start: cur, end: c.start, action: FLOORED.has(lastAction) ? 'downLie' : 'idle', x0: x, x1: x, facing: lastFace, arc: 0, spin: 0 });
      filled.push(c); cur = c.end; x = c.x1; lastAction = c.action; lastFace = c.facing;
    }
    if (cur < end) filled.push({ start: cur, end, action: FLOORED.has(lastAction) ? 'downLie' : 'idle', x0: x, x1: x, facing: lastFace, arc: 0, spin: 0 });
    clips[f.id] = filled;
  }
  return {
    duration: end - t0, clips, impacts: impacts.sort((a, b) => a.t - b.t), sfx: sfx.sort((a, b) => a.t - b.t), lines, projectiles, focus,
    ko: Object.keys(out).filter((k) => out[k]), slowmo,
  };
}


/** Actions with the body off the ground (no foot planting). */
const AIRBORNE = new Set(['jump', 'backflip', 'frontflip', 'flyingKick', 'launch', 'launchFar', 'down', 'downLie', 'getup', 'slide', 'slam', 'blink', 'stagger']);
const LOCOMOTION = new Set(['run', 'dash', 'walk']);
const REACTIONS = new Set(['hit', 'stagger', 'launch', 'launchFar', 'down']);
type FState = { pose: Pose; x: number; y: number; facing: 1 | -1; action: string; local: number };

/** One clip on its own: pose, root motion (with physics for knock-backs). */
function rawState(c: Clip, t: number): FState {
  const local = t - c.start, dur = Math.max(1e-3, c.end - c.start), k = clamp(local / dur, 0, 1);
  const def = ACTIONS[c.action];
  let pose = c.action === 'downLie' ? POSES.down : poseOf(c.action, def?.loop || c.action === 'idle' ? local : local * (def ? def.dur / dur : 1));
  let x: number, y: number;
  if (c.action === 'launch' || c.action === 'launchFar' || c.action === 'down') {
    // Ballistic: thrown back fast, slowing down; a short flight, a bounce, then a slide to a stop.
    const fe = c.action === 'launch' ? 0.5 : 0.6;
    x = c.x0 + (c.x1 - c.x0) * (1 - Math.pow(1 - k, 2.4));
    const air = k < fe ? 4 * (k / fe) * (1 - k / fe) : k < fe + 0.16 ? 0.2 * 4 * ((k - fe) / 0.16) * (1 - (k - fe) / 0.16) : 0;
    y = pose.y + c.arc * air;
    if (c.spin) pose = { ...pose, rot: pose.rot + c.spin * ease(Math.min(1, k / fe)) };
  } else {
    const move = LOCOMOTION.has(c.action) || c.action === 'stagger' ? k : c.action === 'blink' ? (k < 0.5 ? 0 : 1) : def?.impact !== undefined ? snap(k * 1.6) : ease(k);
    x = c.x0 + (c.x1 - c.x0) * move;
    y = pose.y + (c.arc ? Math.sin(Math.PI * k) * c.arc : 0);
    if (c.spin) pose = { ...pose, rot: pose.rot + c.spin * ease(k) };
  }
  return { pose, x, y, facing: c.facing, action: c.action, local };
}

/** Two-bone leg IK: hip at (0,0), foot target (forward, down) in figure units → hip and knee angles. */
function legIK(tx: number, ty: number): { l: number; k: number } {
  const L = BONES.thigh, d = Math.min(Math.hypot(tx, ty), L * 2 - 0.4);
  const th = Math.atan2(tx, ty) * 180 / Math.PI, ph = Math.acos(d / (L * 2)) * 180 / Math.PI;
  return { l: th + ph, k: ph * 2 };
}

/**
 * Feet stay planted on the ground: the stance comes from the key poses, but
 * when the body travels (a lunge, a step back after a hit, a dodge) the feet
 * take real steps — the lead foot first, then the back foot — instead of
 * sliding. The legs are solved to reach the ground (knees bend as the hips
 * drop).
 */
function plantFeet(st: FState, c: Clip) {
  const p = st.pose;
  const J = joints(p, 1);
  const ground = BONES.thigh + BONES.shin - 6 + st.y;
  const D = c.x1 - c.x0;
  const k = Math.abs(D) > 1 ? clamp((st.x - c.x0) / D, 0, 1) : 1;
  const fwd = D * c.facing; // travel in the fighter's own forward direction
  const legs: [('F' | 'B'), [number, number]][] = [['F', J.fF], ['B', J.fB]];
  const leadIsFront = fwd >= 0;
  const out: any = { ...p };
  for (const [leg, foot] of legs) {
    if (foot[1] < ground - 16) continue; // that leg is kicking / lifted in the key pose
    const lead = (leg === 'F') === leadIsFront;
    const sk = lead ? clamp(k / 0.55, 0, 1) : clamp((k - 0.45) / 0.55, 0, 1);
    const stepped = fwd * ease(sk) - fwd * k; // where the foot is vs where the hips are
    const liftUp = Math.abs(fwd) > 6 ? Math.sin(Math.PI * sk) * Math.min(16, Math.abs(fwd) * 0.18) : 0;
    const ik = legIK(foot[0] + stepped, ground - liftUp);
    if (leg === 'F') { out.lF = ik.l; out.kF = ik.k; } else { out.lB = ik.l; out.kB = ik.k; }
  }
  st.pose = out;
}

/** A fighter's state at time t: pose, position, facing. */
export function fighterAt(ch: Choreo, id: string, t: number): FState {
  const list = ch.clips[id] || [];
  let ci = list.findIndex((x) => t >= x.start && t < x.end);
  if (ci < 0) ci = list.length && t < list[0].start ? 0 : list.length - 1;
  const c = list[ci];
  if (!c) return { pose: POSES.guard, x: 0, y: 0, facing: 1, action: 'idle', local: 0 };
  const st = rawState(c, t);
  // Blend out of the previous clip (no pose pops between moves); reactions blend fast so hits still snap.
  const prev = ci > 0 ? list[ci - 1] : null;
  const B = REACTIONS.has(c.action) ? 0.045 : 0.12;
  if (prev && st.local < B && prev.facing === c.facing && prev.action !== 'blink') {
    const pe = rawState(prev, prev.end - 1e-3);
    const w = ease(st.local / B);
    st.pose = lerpPose(pe.pose, st.pose, w);
    st.y = pe.y + (st.y - pe.y) * w;
  }
  if (!AIRBORNE.has(c.action) && !LOCOMOTION.has(c.action) && !c.arc && Math.abs(st.pose.rot) < 1) plantFeet(st, c);
  return st;
}

// ---------------------------------------------------------------------------
// Drawing (canvas)
// ---------------------------------------------------------------------------
export const BONES = { torso: 62, neck: 8, head: 15, upper: 31, fore: 29, thigh: 40, shin: 40 };

export interface Joints { hip: [number, number]; neck: [number, number]; head: [number, number]; sF: [number, number]; eF: [number, number]; hF: [number, number]; eB: [number, number]; hB: [number, number]; kF: [number, number]; fF: [number, number]; kB: [number, number]; fB: [number, number] }

/** Forward kinematics in figure units (y down, hip at 0,0). */
export function joints(p: Pose, facing: 1 | -1): Joints {
  const r = (d: number) => (d * Math.PI) / 180;
  const limb = (from: [number, number], ang: number, len: number): [number, number] => [from[0] + Math.sin(r(ang)) * len * facing, from[1] + Math.cos(r(ang)) * len];
  const hip: [number, number] = [0, 0];
  const neck: [number, number] = [Math.sin(r(p.lean)) * BONES.torso * facing, -Math.cos(r(p.lean)) * BONES.torso];
  const hd = r(p.lean + p.head);
  const head: [number, number] = [neck[0] + Math.sin(hd) * (BONES.neck + BONES.head) * facing, neck[1] - Math.cos(hd) * (BONES.neck + BONES.head)];
  const sh: [number, number] = [neck[0] - Math.sin(r(p.lean)) * 4 * facing, neck[1] + Math.cos(r(p.lean)) * 4];
  // Arm angles are relative to the torso's lean.
  const eF = limb(sh, p.aF + p.lean, BONES.upper), hF = limb(eF, p.aF + p.lean + p.eF, BONES.fore);
  const eB = limb(sh, p.aB + p.lean, BONES.upper), hB = limb(eB, p.aB + p.lean + p.eB, BONES.fore);
  const kF = limb(hip, p.lF, BONES.thigh), fF = limb(kF, p.lF - p.kF, BONES.shin);
  const kB = limb(hip, p.lB, BONES.thigh), fB = limb(kB, p.lB - p.kB, BONES.shin);
  return { hip, neck, head, sF: sh, eF, hF, eB, hB, kF, fF, kB, fB };
}

export type Gear = 'none' | 'headband' | 'crown' | 'cape' | 'visor' | 'glasses' | 'hardhat' | 'helmet' | 'hood' | 'antenna';
export interface StickStyle {
  ink: string; accent: string; width: number; weapon?: 'none' | 'sword' | 'staff'; glow?: string;
  /** Solid-colour body (fight-edit look): the whole figure in `ink`, no headband. */
  solid?: boolean;
  gear?: Gear;
  /** Body size (1 = normal; a brute is bigger, minions smaller). */
  size?: number;
  /** Square robot head. */
  squareHead?: boolean;
}

/** Height of the hip above the ground for a fighter (units, before lift). */
export const hipHeight = (size = 1) => (BONES.thigh + BONES.shin - 6) * size;

/**
 * Draws one fighter. (x, groundY) is the hip's ground position on screen,
 * `scale` screen pixels per unit.
 */
export function drawFighter(ctx: CanvasRenderingContext2D, p: Pose, facing: 1 | -1, x: number, groundY: number, lift: number, scale: number, st: StickStyle, alpha = 1) {
  const J = joints(p, facing);
  const size = st.size || 1;
  const sc = scale * size;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Hip sits a leg-length above the ground; lying poses rest on the floor.
  const baseY = groundY - hipHeight(size) * scale - lift * scale;
  ctx.translate(x, baseY);
  if (p.rot) { ctx.translate(0, -30 * sc); ctx.rotate((p.rot * Math.PI) / 180 * facing); ctx.translate(0, 30 * sc); }
  ctx.scale(sc, sc);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const seg = (pts: [number, number][], w: number, color: string) => {
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
  };
  const W = st.width;
  const ink = st.ink;
  if (st.glow) { ctx.shadowColor = st.glow; ctx.shadowBlur = 16; }
  // Cape behind everything.
  if (st.gear === 'cape') {
    const sway = Math.sin(p.lean / 20) * 8;
    ctx.beginPath(); ctx.moveTo(J.neck[0], J.neck[1] + 2);
    ctx.quadraticCurveTo(J.neck[0] - 30 * facing, J.hip[1] - 10, J.hip[0] - (38 + sway) * facing, J.hip[1] + 26);
    ctx.lineTo(J.hip[0] - 8 * facing, J.hip[1] + 18); ctx.closePath();
    ctx.fillStyle = st.accent; ctx.globalAlpha = alpha * 0.9; ctx.fill(); ctx.globalAlpha = alpha;
  }
  // Back limbs slightly darker for depth (solid look: same colour, a touch transparent).
  const back = st.solid ? ink : ink;
  ctx.globalAlpha = alpha * (st.solid ? 0.82 : 1);
  seg([J.sF, J.eB, J.hB], W * 0.92, back);
  seg([J.hip, J.kB, J.fB], W * 0.95, back);
  ctx.globalAlpha = alpha;
  seg([J.hip, J.neck], W * 1.1, ink);
  seg([J.hip, J.kF, J.fF], W, ink);
  // Weapon in the front hand.
  if (st.weapon === 'sword' || st.weapon === 'staff') {
    const ang = Math.atan2(J.hF[1] - J.eF[1], J.hF[0] - J.eF[0]);
    const len = st.weapon === 'sword' ? 70 : 95;
    const tip: [number, number] = [J.hF[0] + Math.cos(ang) * len, J.hF[1] + Math.sin(ang) * len];
    const bk: [number, number] = [J.hF[0] - Math.cos(ang) * (st.weapon === 'staff' ? 40 : 10), J.hF[1] - Math.sin(ang) * (st.weapon === 'staff' ? 40 : 10)];
    seg([bk, tip], st.weapon === 'sword' ? 4 : 5, st.weapon === 'sword' ? (st.solid ? '#6b7280' : '#e5e7eb') : '#8b5a2b');
    if (st.weapon === 'sword') seg([[J.hF[0] - Math.sin(ang) * 9, J.hF[1] + Math.cos(ang) * 9], [J.hF[0] + Math.sin(ang) * 9, J.hF[1] - Math.cos(ang) * 9]], 5, st.solid ? '#111827' : st.accent);
  }
  seg([J.sF, J.eF, J.hF], W, ink);
  ctx.shadowBlur = 0;
  // Head
  const hr = BONES.head;
  if (st.squareHead) { ctx.fillStyle = ink; roundedRect(ctx, J.head[0] - hr, J.head[1] - hr, hr * 2, hr * 2, 4); ctx.fill(); }
  else { ctx.beginPath(); ctx.arc(J.head[0], J.head[1], hr, 0, Math.PI * 2); ctx.fillStyle = ink; ctx.fill(); }
  const hb = Math.atan2(J.head[1] - J.neck[1], J.head[0] - J.neck[0]);
  const gear = st.gear || (st.solid ? 'none' : 'headband');
  const up = (d: number): [number, number] => [J.head[0] + Math.cos(hb) * d, J.head[1] + Math.sin(hb) * d];
  const side = (d: number, along = 0): [number, number] => [J.head[0] + Math.cos(hb) * along - Math.sin(hb) * d, J.head[1] + Math.sin(hb) * along + Math.cos(hb) * d];
  if (gear === 'headband') {
    const bx = J.head[0] - Math.cos(hb) * 3, by = J.head[1] - Math.sin(hb) * 3;
    ctx.beginPath(); ctx.arc(bx, by, hr * 0.98, hb + Math.PI / 2 - 0.9, hb + Math.PI / 2 + 0.9); ctx.strokeStyle = st.accent; ctx.lineWidth = 5; ctx.stroke();
    const tail: [number, number] = [J.head[0] - 16 * facing, J.head[1] - 2];
    seg([[J.head[0] - 10 * facing, J.head[1] - 4], tail, [tail[0] - 16 * facing, tail[1] + 10 + Math.sin(p.lean) * 4]], 4, st.accent);
  } else if (gear === 'crown') {
    const c = up(hr + 2), a = hb;
    const pt = (dx: number, dy: number): [number, number] => [c[0] - Math.sin(a) * dx + Math.cos(a) * dy, c[1] + Math.cos(a) * dx + Math.sin(a) * dy];
    ctx.beginPath();
    const pts = [pt(-13, -2), pt(-15, 12), pt(-7, 5), pt(0, 15), pt(7, 5), pt(15, 12), pt(13, -2)];
    ctx.moveTo(pts[0][0], pts[0][1]); for (const q of pts.slice(1)) ctx.lineTo(q[0], q[1]); ctx.closePath();
    ctx.fillStyle = '#facc15'; ctx.fill(); ctx.strokeStyle = '#a16207'; ctx.lineWidth = 2; ctx.stroke();
  } else if (gear === 'visor' || gear === 'glasses') {
    const a = side(0, 2), f = facing;
    ctx.strokeStyle = gear === 'visor' ? '#22d3ee' : '#111827'; ctx.lineWidth = gear === 'visor' ? 6 : 3;
    ctx.beginPath(); ctx.moveTo(a[0] + 2 * f, a[1] - 1); ctx.lineTo(a[0] + hr * 1.05 * f, a[1] - 1); ctx.stroke();
    if (gear === 'glasses') { ctx.beginPath(); ctx.arc(a[0] + hr * 0.62 * f, a[1], 5.5, 0, Math.PI * 2); ctx.fillStyle = '#e5e7eb'; ctx.fill(); ctx.stroke(); }
  } else if (gear === 'hardhat' || gear === 'helmet') {
    const c = J.head, a = hb;
    ctx.beginPath(); ctx.arc(c[0], c[1], hr + 3, a - Math.PI / 2 - 0.15, a + Math.PI / 2 + 0.15); ctx.closePath();
    ctx.fillStyle = gear === 'hardhat' ? '#facc15' : '#4b5563'; ctx.fill();
    const l = side(-(hr + 7), -1), rr = side(hr + 7, -1);
    seg([l, rr], 4, gear === 'hardhat' ? '#ca8a04' : '#1f2937');
  } else if (gear === 'hood') {
    ctx.beginPath(); ctx.arc(J.head[0], J.head[1], hr + 4, hb - 2.4, hb + 2.4); ctx.strokeStyle = st.accent; ctx.lineWidth = 6; ctx.stroke();
  } else if (gear === 'antenna') {
    const b = up(hr), tip = up(hr + 16);
    seg([b, tip], 3, ink); ctx.beginPath(); ctx.arc(tip[0], tip[1], 4.5, 0, Math.PI * 2); ctx.fillStyle = '#f43f5e'; ctx.fill();
  }
  if (!st.solid) { ctx.beginPath(); ctx.arc(J.hip[0], J.hip[1] - 4, 5, 0, Math.PI * 2); ctx.fillStyle = st.accent; ctx.fill(); }
  ctx.restore();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// ===========================================================================
// VS fight planner — "Speed vs Strength", "King vs Army", "Engineer vs AI agents"
// ===========================================================================
export type Archetype = 'speed' | 'strength' | 'tech' | 'magic' | 'sword' | 'brawler' | 'ninja';
export const ARCHETYPES: Archetype[] = ['speed', 'strength', 'tech', 'magic', 'sword', 'brawler', 'ninja'];

interface MoveSet { approach: 'run' | 'dash' | 'walk'; attacks: [string, number][]; defend: string[]; defendRate: number; finisher: string[]; openers: string[]; size: number; weapon: 'none' | 'sword' | 'staff' }
export const MOVESETS: Record<Archetype, MoveSet> = {
  speed: { approach: 'dash', attacks: [['flurry', 3], ['jab', 2], ['combo', 2], ['kick', 2], ['roundhouse', 1], ['blink', 2]], defend: ['dodge', 'dodge', 'backflip', 'duck'], defendRate: 0.5, finisher: ['flurry', 'roundhouse', 'flyingKick'], openers: ['blink', 'dash'], size: 0.95, weapon: 'none' },
  strength: { approach: 'walk', attacks: [['heavyPunch', 3], ['slam', 2], ['uppercut', 2], ['punch', 2]], defend: ['block', 'block'], defendRate: 0.4, finisher: ['heavyPunch', 'slam'], openers: ['flex'], size: 1.22, weapon: 'none' },
  tech: { approach: 'run', attacks: [['blast', 3], ['beam', 1], ['punch', 2], ['kick', 1]], defend: ['block', 'dodge'], defendRate: 0.35, finisher: ['beam'], openers: ['taunt'], size: 1, weapon: 'none' },
  magic: { approach: 'run', attacks: [['blast', 3], ['beam', 2], ['kick', 1]], defend: ['dodge', 'backflip'], defendRate: 0.35, finisher: ['beam'], openers: ['taunt'], size: 1, weapon: 'staff' },
  sword: { approach: 'run', attacks: [['slash', 3], ['dashSlash', 2], ['kick', 1]], defend: ['block', 'dodge'], defendRate: 0.4, finisher: ['dashSlash', 'slash'], openers: ['taunt'], size: 1, weapon: 'sword' },
  brawler: { approach: 'run', attacks: [['punch', 3], ['combo', 3], ['kick', 2], ['uppercut', 2], ['roundhouse', 1]], defend: ['block', 'duck'], defendRate: 0.35, finisher: ['uppercut', 'roundhouse'], openers: ['taunt'], size: 1.05, weapon: 'none' },
  ninja: { approach: 'dash', attacks: [['flyingKick', 2], ['kick', 2], ['roundhouse', 2], ['combo', 2], ['blink', 1]], defend: ['backflip', 'dodge', 'duck'], defendRate: 0.45, finisher: ['flyingKick', 'roundhouse'], openers: ['frontflip'], size: 0.95, weapon: 'none' },
};

export interface VsSide { id: 'A' | 'B'; name: string; label: string; archetype: Archetype; color: string; count: number; gear?: Gear }
export interface VsRound { winner: 'A' | 'B'; lines?: { side: 'A' | 'B'; when: 'start' | 'end'; text: string }[] }

export function rng(seedText: string) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 16777619); }
  let s = h >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, pick: <T>(a: T[]) => a[Math.floor(next() * a.length) % a.length], weighted: (a: [string, number][]) => { const tot = a.reduce((n, x) => n + x[1], 0); let r = next() * tot; for (const [k, w] of a) { r -= w; if (r <= 0) return k; } return a[0][0]; } };
}

/** The fighters of both sides (a side with count > 1 is a crowd of smaller members). */
export function vsFighters(sides: VsSide[]): (Fighter & { side: 'A' | 'B'; archetype: Archetype; style: StickStyle })[] {
  const out: (Fighter & { side: 'A' | 'B'; archetype: Archetype; style: StickStyle })[] = [];
  for (const s of sides) {
    const ms = MOVESETS[s.archetype] || MOVESETS.brawler;
    const n = clamp(Math.round(s.count || 1), 1, 10);
    const dir = s.id === 'A' ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const crowd = n > 1;
      out.push({
        id: n === 1 ? s.id : `${s.id}${i + 1}`, name: n === 1 ? s.name : `${s.name} ${i + 1}`, color: s.color, team: s.id, side: s.id, archetype: s.archetype,
        x: dir * (230 + i * 120), approach: ms.approach, weapon: ms.weapon,
        style: { ink: s.color, accent: s.color, width: crowd ? 10 : 11.5, solid: true, gear: s.gear || 'none', size: crowd ? ms.size * 0.9 : ms.size, weapon: ms.weapon, squareHead: s.gear === 'antenna' || /\b(ai|bot|robot|agent|android|machine)\b/i.test(s.name) },
      });
    }
  }
  return out;
}

/**
 * Beats for one round. The script decides who wins the round; the planner
 * makes it a real fight: both sides land blows, the loser defends and
 * counters, the round ends with the winner's finisher (a knockout).
 */
export function planRound(sides: VsSide[], round: VsRound, index: number, total: number, seconds: number, seed: string): Beat[] {
  const r = rng(`${seed}:round${index}`);
  const fighters = vsFighters(sides);
  const W = round.winner, L: 'A' | 'B' = W === 'A' ? 'B' : 'A';
  const sideOf = (id: 'A' | 'B') => sides.find((s) => s.id === id)!;
  const members = (id: 'A' | 'B') => fighters.filter((f) => f.side === id).map((f) => f.id);
  const standing: Record<string, boolean> = {};
  fighters.forEach((f) => (standing[f.id] = true));
  const alive = (id: 'A' | 'B') => members(id).filter((m) => standing[m]);
  const beats: Beat[] = [];
  let est = 0;
  const cost = (a: string) => (ACTIONS[a]?.dur || 0.6) * 0.85 + 0.25;
  const push = (b: Beat) => { beats.push(b); est += cost(b.action); };
  const line = (side: 'A' | 'B', when: 'start' | 'end') => (round.lines || []).find((l) => l.side === side && l.when === when)?.text;
  // Opening: each side shows off (and may talk).
  for (const sid of index % 2 ? [L, W] : [W, L]) {
    const ms = MOVESETS[sideOf(sid).archetype];
    const who = alive(sid)[0];
    const text = line(sid, 'start');
    if (text) push({ actor: who, action: sid === W && ms.openers.includes('flex') ? 'flex' : 'taunt', line: text });
    else if (r.next() < 0.5) push({ actor: who, action: r.pick(ms.openers.filter((o) => !['dash', 'blink'].includes(o)).concat(['taunt'])) });
  }
  const crowdSide = (['A', 'B'] as const).find((s) => members(s).length > 1);
  // The crowd loses members along the way when it loses the round; when it wins, it wears the hero down.
  const koBudget = crowdSide ? (crowdSide === L ? members(crowdSide).length - 1 : Math.min(members(crowdSide).length - 1, Math.floor(members(crowdSide).length / 2))) : 0;
  let kos = 0;
  const target = seconds - 2.2; // leave room for the finisher + victory
  let n = 0;
  while (est < target && n < 60) {
    n++;
    const late = est / target;
    const winnerTurn = r.next() < 0.52 + late * 0.25;
    const atkSide: 'A' | 'B' = winnerTurn ? W : L;
    const defSide: 'A' | 'B' = atkSide === 'A' ? 'B' : 'A';
    const atkList = alive(atkSide), defList = alive(defSide);
    if (!atkList.length || !defList.length) break;
    const actor = r.pick(atkList);
    const tgt = r.pick(defList);
    const ms = MOVESETS[sideOf(atkSide).archetype];
    let action = r.weighted(ms.attacks);
    if (action === 'blink') { push({ actor, action: 'blink', target: tgt }); action = r.pick(['flurry', 'kick', 'combo']); }
    const defMs = MOVESETS[sideOf(defSide).archetype];
    // Crowd members: one or two good hits and they're out (when the crowd is losing).
    const crowdKo = crowdSide === defSide && kos < koBudget && defList.length > 1 && r.next() < (defSide === L ? 0.55 : 0.3);
    push({ actor, action, target: tgt, ko: crowdKo || undefined });
    if (crowdKo) { standing[tgt] = false; kos++; continue; }
    // Defend (the round's loser defends less as the round goes on).
    const rate = defMs.defendRate * (defSide === L ? 1 - late * 0.5 : 1);
    if (r.next() < rate && !ACTIONS[action].aoe) push({ actor: tgt, action: r.pick(defMs.defend) });
    // Counter-attack after a defence sometimes.
    else if (r.next() < 0.18 && ACTIONS[action].effect !== 'launchFar') {
      const cms = MOVESETS[sideOf(defSide).archetype];
      push({ actor: tgt, action: r.weighted(cms.attacks.filter((a) => a[0] !== 'blink')), target: actor });
    }
  }
  // Finisher: the winner knocks out whoever is left (a crowd winning piles on).
  const wms = MOVESETS[sideOf(W).archetype];
  const lefts = alive(L);
  const winners = alive(W);
  lefts.forEach((victim, i) => {
    const actor = winners[i % winners.length];
    const fin = r.pick(wms.finisher);
    if (wms.approach === 'dash' && r.next() < 0.5) push({ actor, action: 'blink', target: victim });
    // The last knockout of the round plays in slow motion.
    push({ actor, action: fin, target: victim, ko: true, slow: i === lefts.length - 1 ? 2.3 : undefined });
  });
  const endLine = line(W, 'end');
  push({ actor: winners[0], action: endLine && wms.openers.includes('flex') ? 'flex' : 'victory', line: endLine });
  return beats;
}

/** Health per side over a round: the round's loser reaches 0 at the knockout, the winner never does. */
export function roundHealth(ch: Choreo, fighters: { id: string; side: 'A' | 'B' }[], winner: 'A' | 'B'): { t: number; A: number; B: number }[] {
  const sideOf = (id?: string) => fighters.find((f) => f.id === id)?.side;
  const loser = winner === 'A' ? 'B' : 'A';
  const dmg = { A: 0, B: 0 } as Record<'A' | 'B', number>;
  for (const im of ch.impacts) { const s = sideOf(im.target); if (s && im.dmg) dmg[s] += im.dmg; }
  const scale = { [loser]: dmg[loser] > 0 ? 100 / dmg[loser] : 1, [winner]: dmg[winner] > 0 ? Math.min(1, 72 / dmg[winner]) : 1 } as Record<'A' | 'B', number>;
  const out: { t: number; A: number; B: number }[] = [{ t: -1e9, A: 100, B: 100 }];
  const hp = { A: 100, B: 100 };
  for (const im of ch.impacts) {
    const s = sideOf(im.target);
    if (!s || !im.dmg) continue;
    hp[s] = Math.max(0, hp[s] - im.dmg * scale[s]);
    out.push({ t: im.t, A: hp.A, B: hp.B });
  }
  const last = out[out.length - 1];
  if (last[loser] > 0.5) out.push({ t: (ch.impacts[ch.impacts.length - 1]?.t ?? 0) + 0.01, A: loser === 'A' ? 0 : last.A, B: loser === 'B' ? 0 : last.B });
  return out;
}
