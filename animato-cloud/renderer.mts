/**
 * Animato AutoPoster — cloud renderer (runs on GitHub Actions).
 *
 * One run = one episode:
 *   1. read the job from the repository_dispatch payload
 *   2. ask the app whether the automation still exists / isn't paused
 *   3. write the episode as timed scenes with free Google Gemini models
 *      (10 rotating keys, instant failover) and Groq as the fallback —
 *      grounded in fresh, never-repeated headlines for tech/news
 *   4. narrate it with a neural voice, keeping word-level timings
 *   5. find an image for every scene (AI images for stories/cooking, real
 *      photos first for tech/news)
 *   6. render in headless Chrome with the app's own character engine:
 *      real lip-sync, blinking, glances, head motion, looking at each image,
 *      word-by-word captions — then encode with FFmpeg
 *   7. publish to YouTube as a Short or a regular video
 *   8. report the episode back to the app, which schedules the next one
 *
 * No npm dependencies: Node 22 built-ins, FFmpeg, Chrome, Python edge-tts.
 * The presenter is the CSS character designed in the app (only its small
 * JSON spec travels in the job; the stage draws it).
 * Run with:  node --experimental-strip-types animato-cloud/renderer.mts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LlmPool, extractJsonObject } from './llm.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = process.env;
const IN_ACTIONS = ENV.GITHUB_ACTIONS === 'true';

function readEvent(): any {
  try {
    if (ENV.GITHUB_EVENT_PATH && fs.existsSync(ENV.GITHUB_EVENT_PATH)) {
      return JSON.parse(fs.readFileSync(ENV.GITHUB_EVENT_PATH, 'utf8'));
    }
  } catch (err: any) {
    console.warn('Could not read the GitHub event payload:', err?.message);
  }
  return {};
}

const EVENT = readEvent();
const CP = EVENT.client_payload || {};
const INPUTS = EVENT.inputs || {};
const JOB = CP.job || {};
const AUTH = CP.auth || {};

function pick(...values: any[]): string {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

const DEFAULT_YT_CLIENT_ID = '592242596648-am9pri2j11vmu44fdc6oau5p34aklkj8.apps.googleusercontent.com';
// API keys are never stored in the render repository: the app sends them in
// every dispatch (auth.*), or they come from repository secrets.

const DIMENSIONS: Record<string, [number, number]> = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:3': [1440, 1080] };

function resolveFormat(): { format: 'shorts' | 'video'; aspect: string } {
  const rawAspect = pick(JOB.aspect_ratio, INPUTS.aspect_ratio, ENV.ASPECT_RATIO, '9:16').replace('/', ':');
  let aspect = DIMENSIONS[rawAspect] ? rawAspect : '9:16';
  const rawFormat = pick(JOB.format, INPUTS.format, ENV.VIDEO_FORMAT).toLowerCase();
  const format: 'shorts' | 'video' = rawFormat === 'video' ? 'video' : rawFormat === 'shorts' ? 'shorts' : (aspect === '16:9' || aspect === '4:3' ? 'video' : 'shorts');
  if (format === 'shorts' && (aspect === '16:9' || aspect === '4:3')) aspect = '9:16';
  if (format === 'video' && (aspect === '9:16' || aspect === '1:1')) aspect = '16:9';
  return { format, aspect };
}

const rawGender = pick(JOB.gender, INPUTS.gender, ENV.CHARACTER_GENDER, 'female').toLowerCase();
function keyList(...values: any[]): string[] {
  return Array.from(new Set(values
    .flatMap((v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)))
    .map((k) => String(k).trim())
    .filter((k) => k.length > 8)));
}
const listOf = (v: string): string[] | undefined => { const l = String(v || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean); return l.length ? l : undefined; };
function parseSpec(v: any): any | null {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { const o = JSON.parse(String(v)); return o && typeof o === 'object' ? o : null; } catch { return null; }
}
const FMT = resolveFormat();

const CFG = {
  campaignId: pick(CP.campaign_id, INPUTS.campaign_id, ENV.CAMPAIGN_ID),
  partNumber: Math.max(1, parseInt(pick(CP.part_number, INPUTS.part_number, ENV.PART_NUMBER, '1'), 10) || 1),
  appUrl: pick(CP.app_url, INPUTS.app_url, ENV.APP_URL).replace(/\/+$/, ''),
  category: pick(JOB.category, INPUTS.category, ENV.CATEGORY, 'stories').toLowerCase(),
  subGenre: pick(JOB.sub_genre, INPUTS.sub_genre, ENV.SUB_GENRE),
  topic: pick(JOB.topic, INPUTS.topic, ENV.PROMPT, ENV.TOPIC),
  campaignName: pick(JOB.name, ENV.CAMPAIGN_NAME),
  gender: (rawGender === 'male' ? 'male' : 'female') as 'male' | 'female',
  format: FMT.format,
  aspect: FMT.aspect,
  autoPost: pick(JOB.auto_post_youtube, INPUTS.auto_post_youtube, ENV.AUTO_POST_YOUTUBE, 'false').toLowerCase() === 'true',
  previousScript: pick(JOB.previous_script, ENV.PREVIOUS_SCRIPT),
  privacy: pick(JOB.privacy, ENV.YOUTUBE_PRIVACY, 'public'),
  ytRefreshToken: pick(AUTH.youtube_refresh_token, ENV.YOUTUBE_REFRESH_TOKEN),
  ytClientId: pick(AUTH.youtube_client_id, ENV.YOUTUBE_CLIENT_ID, DEFAULT_YT_CLIENT_ID),
  ytClientSecret: pick(AUTH.youtube_client_secret, ENV.YOUTUBE_CLIENT_SECRET),
  // Script writer keys the app sent (comma-separated) + repository secrets; rotated with instant failover.
  geminiKeys: keyList(AUTH.gemini_api_keys, AUTH.gemini_api_key, ENV.GEMINI_API_KEYS, ENV.GEMINI_API_KEY),
  groqKeys: keyList(AUTH.groq_api_keys, AUTH.groq_api_key, ENV.GROQ_API_KEYS, ENV.GROQ_API_KEY),
  geminiModels: listOf(pick(JOB.gemini_models, ENV.GEMINI_MODELS)),
  groqModels: listOf(pick(JOB.groq_models, ENV.GROQ_MODELS)),
  nvidiaKey: pick(AUTH.nvidia_api_key, ENV.NVIDIA_API_KEY),
  characterSpec: parseSpec(pick(JOB.character_spec, ENV.CHARACTER_SPEC)),
  usedHeadlines: String(pick(JOB.used_headlines)).split('\n').map((x) => x.trim()).filter(Boolean),
  pollinationsKey: pick(AUTH.pollinations_key, ENV.POLLINATIONS_API_KEY),
  pexelsKey: pick(AUTH.pexels_key, ENV.PEXELS_API_KEY),
  pixabayKey: pick(AUTH.pixabay_key, ENV.PIXABAY_API_KEY),
  runnerKey: pick(AUTH.runner_key, ENV.ANIMATO_RUNNER_KEY),
  runId: pick(ENV.GITHUB_RUN_ID),
  runUrl: ENV.GITHUB_RUN_ID
    ? `${ENV.GITHUB_SERVER_URL || 'https://github.com'}/${ENV.GITHUB_REPOSITORY}/actions/runs/${ENV.GITHUB_RUN_ID}`
    : '',
  // Test hooks (never set in production).
  dryRun: ENV.ANIMATO_DRY_RUN === 'true',
  offline: ENV.ANIMATO_OFFLINE === 'true',
  geminiBase: pick(ENV.GEMINI_BASE_URL, 'https://generativelanguage.googleapis.com/v1beta'),
  groqBase: pick(ENV.GROQ_BASE_URL, 'https://api.groq.com/openai/v1'),
  googleTokenUrl: pick(ENV.GOOGLE_TOKEN_URL, 'https://oauth2.googleapis.com/token'),
  nvidiaBase: pick(ENV.NVIDIA_GENAI_BASE, 'https://ai.api.nvidia.com/v1/genai'),
  youtubeUploadBase: pick(ENV.YOUTUBE_UPLOAD_BASE, 'https://www.googleapis.com/upload/youtube/v3'),
  newsBase: pick(ENV.NEWS_RSS_BASE, 'https://news.google.com/rss/search'),
  allowFallbackPublish: ENV.PUBLISH_WITH_FALLBACK_CONTENT === 'true',
  maxRenderSeconds: parseInt(pick(ENV.MAX_VIDEO_SECONDS, '0'), 10) || 0
};

if (IN_ACTIONS) {
  for (const secret of [CFG.ytRefreshToken, CFG.ytClientSecret, ...CFG.geminiKeys, ...CFG.groqKeys, CFG.nvidiaKey, CFG.runnerKey, CFG.pollinationsKey, CFG.pexelsKey, CFG.pixabayKey]) {
    if (secret && secret.length > 6) console.log(`::add-mask::${secret}`);
  }
}

const OUTPUT_DIR = path.resolve(ENV.ANIMATO_OUTPUT_DIR || path.join(process.cwd(), 'output'));
const WORK_DIR = path.join(OUTPUT_DIR, 'work');
const OUTPUT_VIDEO = path.join(OUTPUT_DIR, 'rendered_video.mp4');
const OUTPUT_META = path.join(OUTPUT_DIR, 'video_metadata.json');
fs.mkdirSync(WORK_DIR, { recursive: true });

const [W, H] = DIMENSIONS[CFG.aspect];
const FPS = 30;
const IS_SHORTS = CFG.format === 'shorts';

class PipelineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Talking to the app
// ---------------------------------------------------------------------------
async function appRequest(method: string, route: string, body?: any, timeoutMs = 20000): Promise<{ status: number; data: any } | null> {
  if (!CFG.appUrl || !CFG.campaignId) return null;
  try {
    const res = await fetch(`${CFG.appUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Animato-Runner-Key': CFG.runnerKey || '' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, data };
  } catch (err: any) {
    console.warn(`App request ${method} ${route} failed: ${err?.message}`);
    return null;
  }
}

const campaignPath = () => `/api/automation/campaigns/${encodeURIComponent(CFG.campaignId)}`;

async function reportStatus(status: 'running' | 'failed' | 'completed' | 'skipped', step: string, progress: number, logLine: string, extra: Record<string, any> = {}) {
  const res = await appRequest('POST', `${campaignPath()}/status`, {
    status, step, progress, log: logLine, partNumber: CFG.partNumber, runId: CFG.runId, runUrl: CFG.runUrl, ...extra
  });
  if (res && res.status === 401) console.warn('The app rejected the status update (runner key mismatch).');
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------
function run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: Buffer } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    let child: any;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err: any) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(err?.message || err) });
      return;
    }
    const out: Buffer[] = [];
    let err = '';
    let timer: any = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => { err += `\n[timeout after ${opts.timeoutMs}ms]`; try { child.kill('SIGKILL'); } catch {} }, opts.timeoutMs);
    }
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 200000) err = err.slice(-100000); });
    child.on('error', (e: any) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout: Buffer.concat(out), stderr: err + String(e?.message || e) }); });
    child.on('close', (code: number | null) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err }); });
    if (opts.input) child.stdin.end(opts.input); else child.stdin.end();
  });
}

async function probeDuration(file: string): Promise<number> {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(r.stdout.toString().trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

async function imageSize(file: string): Promise<[number, number]> {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [w, h] = r.stdout.toString().trim().split(',').map((n) => parseInt(n, 10));
  return [w || 0, h || 0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clampNum = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------------------
// 1. Script — free Gemini models (Groq fallback), written as timed scenes
// ---------------------------------------------------------------------------
/** A performance cue placed before the `index`-th spoken word of a scene. */
interface Cue { index: number; tag: string }
interface Scene { narration: string; shot: 'scene' | 'panel' | 'full'; emotion: string; imagePrompt: string; searchQuery: string; cues: Cue[] }

// ---------------------------------------------------------------------------
// Performance tags: the script writer places [tags] inside the narration right
// before the word where a change should land. They are removed from the voice
// and captions and turned into cues timed to that exact word.
// ---------------------------------------------------------------------------
const EMOTION_TAGS = ['neutral', 'happy', 'excited', 'sad', 'crying', 'serious', 'worried', 'scared', 'surprised', 'angry', 'calm', 'curious', 'laugh'];
const GESTURE_TAGS = ['look_image', 'look_left', 'look_right', 'look_up', 'think', 'nod', 'shake_head', 'lean_in',
  'point', 'explain', 'count', 'wave', 'shrug', 'hands_up', 'hand_chest', 'fist'];
const TAG_ALIASES: Record<string, string> = {
  joy: 'happy', joyful: 'happy', smile: 'happy', smiling: 'happy', cheerful: 'happy', warm: 'happy', amused: 'happy', hopeful: 'happy', proud: 'happy', relieved: 'happy',
  excitement: 'excited', thrilled: 'excited', enthusiastic: 'excited', energetic: 'excited',
  sadness: 'sad', sorrow: 'sad', somber: 'sad', melancholy: 'sad', grief: 'sad', lonely: 'sad', disappointed: 'sad', tearful: 'crying', cry: 'crying',
  tense: 'worried', anxious: 'worried', nervous: 'worried', uneasy: 'worried', concerned: 'worried', suspense: 'worried',
  fear: 'scared', afraid: 'scared', terrified: 'scared', horrified: 'scared', frightened: 'scared', dread: 'scared',
  shock: 'surprised', shocked: 'surprised', amazed: 'surprised', astonished: 'surprised', wow: 'surprised',
  anger: 'angry', furious: 'angry', frustrated: 'angry', mad: 'angry',
  focused: 'serious', grave: 'serious', stern: 'serious', urgent: 'serious', dramatic: 'serious', mysterious: 'serious', determined: 'serious',
  relaxed: 'calm', gentle: 'calm', soft: 'calm', thoughtful: 'curious', intrigued: 'curious', wonder: 'curious',
  look_at_image: 'look_image', look_at_picture: 'look_image', look_picture: 'look_image', look_screen: 'look_image', show: 'look_image', look_side: 'look_image',
  pointing: 'point', point_image: 'point', point_at_image: 'point', point_screen: 'point', gesture: 'explain', explaining: 'explain', open_hands: 'explain', present: 'explain', presenting: 'explain',
  one: 'count', step: 'count', counting: 'count', number: 'count', hello: 'wave', hi: 'wave', goodbye: 'wave', bye: 'wave', waving: 'wave',
  shrugging: 'shrug', dunno: 'shrug', whoa: 'hands_up', hands_up: 'hands_up', raise_hands: 'hands_up', heart: 'hand_chest', hand_on_heart: 'hand_chest', chest: 'hand_chest',
  fist_pump: 'fist', clenched: 'fist', laughing: 'laugh', laughs: 'laugh', haha: 'laugh', giggle: 'laugh', chuckle: 'laugh', chuckles: 'laugh', grin: 'happy',
  glance_left: 'look_left', glance_right: 'look_right', look_away: 'look_left', thinking: 'think', ponder: 'think', hmm: 'think',
  shake: 'shake_head', head_shake: 'shake_head', no: 'shake_head', yes: 'nod', nodding: 'nod', lean: 'lean_in', lean_forward: 'lean_in', whisper: 'lean_in'
};

function normaliseTag(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const v = TAG_ALIASES[t] || t;
  return EMOTION_TAGS.includes(v) || GESTURE_TAGS.includes(v) ? v : null;
}

const cleanNarration = (s: string) => s.replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim();
const speechTokens = (s: string) => cleanForSpeech(s).split(/\s+/).filter(Boolean);

/** Split "[sad] She waited. [look_image] The door..." into clean text + cues at word indexes. */
function parseTaggedNarration(raw: string): { text: string; cues: Cue[] } {
  const cues: Cue[] = [];
  let text = '';
  let last = 0;
  for (const m of raw.matchAll(/\[([A-Za-z][A-Za-z _-]{1,28})\]|\(([A-Za-z][A-Za-z _-]{1,28})\)/g)) {
    const tag = normaliseTag(m[1] || m[2]);
    if (!tag && m[2]) continue; // an ordinary parenthesis stays in the text
    text += raw.slice(last, m.index) + ' ';
    last = (m.index || 0) + m[0].length;
    if (tag) cues.push({ index: speechTokens(cleanNarration(text)).length, tag });
  }
  text += raw.slice(last);
  const clean = cleanNarration(text.replace(/\[[^\]]{0,40}\]/g, ' '));
  const count = speechTokens(clean).length;
  return { text: clean, cues: cues.map((c) => ({ ...c, index: Math.min(c.index, count) })) };
}

/**
 * Fallback direction for scripts that came back with few tags: read each
 * sentence's mood from its words so the face still follows the story.
 */
const MOOD_WORDS: [RegExp, string][] = [
  [/\b(died|dead|death|funeral|grave|lost|lonely|cried|tears|goodbye|miss(ed)? (him|her|you)|tragic|heartbroken|sorry)\b/i, 'sad'],
  [/\b(scream|screamed|blood|shadow|footsteps|knock(ing|ed)?|whisper(ed)?|creak(ed|ing)?|behind (me|her|him)|something moved|dark(ness)?|terrif)/i, 'scared'],
  [/\b(suddenly|can't believe|unbelievable|shocking|out of nowhere|no way|wait,|what\?)/i, 'surprised'],
  [/\b(warning|danger(ous)?|crisis|killed|war|storm|flood|crash|urgent|arrested|attack|emergency|record low|collapsed?)\b/i, 'serious'],
  [/\b(worried|nervous|strange|wrong|weird|uneasy|missing|nobody|locked|alone)\b/i, 'worried'],
  [/\b(haha|hilarious|laughed|so funny|joked?)\b/i, 'laugh'],
  [/\b(amazing|incredible|delicious|perfect|love|finally|won|win|best|beautiful|great news|good news|sunny|celebrat|crispy|golden|easy)\b/i, 'happy'],
  [/\b(furious|outrage|angry|betrayed|unfair|lied)\b/i, 'angry']
];

function autoCues(scene: Scene): Cue[] {
  const cues = [...scene.cues];
  if (cues.filter((c) => EMOTION_TAGS.includes(c.tag)).length >= 2) return cues;
  const tokens = speechTokens(scene.narration);
  let sentence: string[] = [];
  let startIdx = 0;
  const flush = (endIdx: number) => {
    const text = sentence.join(' ');
    sentence = [];
    const hasEmotion = cues.some((c) => EMOTION_TAGS.includes(c.tag) && c.index >= startIdx && c.index < endIdx);
    if (!hasEmotion) {
      const mood = MOOD_WORDS.find(([re]) => re.test(text));
      if (mood) cues.push({ index: startIdx, tag: mood[1] });
    }
    if (/!$/.test(text) && !cues.some((c) => c.tag === 'nod' && c.index >= startIdx && c.index < endIdx)) cues.push({ index: Math.max(startIdx, endIdx - 1), tag: 'nod' });
    startIdx = endIdx;
  };
  tokens.forEach((tok, i) => {
    sentence.push(tok);
    if (/[.!?]["')\]]*$/.test(tok) || i === tokens.length - 1) flush(i + 1);
  });
  return cues.sort((a, b) => a.index - b.index);
}

/** Every cue as an absolute time, pinned to the word it was written before. */
function timeCues(scenes: Scene[], words: Word[], times: { start: number; end: number }[]): { t: number; tag: string }[] {
  const out: { t: number; tag: string }[] = [];
  let tokenStart = 0;
  scenes.forEach((s, i) => {
    const count = speechTokens(s.narration).length;
    const inScene = words.filter((w) => (w.token ?? -1) >= tokenStart && (w.token ?? -1) < tokenStart + count);
    const firstWordAt = inScene[0]?.start ?? times[i].start;
    const cues = autoCues(s);
    if (!cues.some((c) => c.index === 0 && EMOTION_TAGS.includes(c.tag))) {
      const e = emotionTag(s.emotion);
      if (e) cues.unshift({ index: 0, tag: e });
    }
    for (const c of cues) {
      let t: number;
      if (c.index >= count) t = inScene.length ? inScene[inScene.length - 1].end : times[i].end;
      else if (c.index === 0) t = firstWordAt;
      else t = (inScene.find((w) => (w.token ?? -1) >= tokenStart + c.index)?.start) ?? firstWordAt;
      out.push({ t: +Math.max(0, t).toFixed(3), tag: c.tag });
    }
    tokenStart += count;
  });
  return out.sort((a, b) => a.t - b.t);
}

/** Scene-level emotion (the JSON "emotion" field) as a tag. */
function emotionTag(e: string): string | null {
  const t = normaliseTag(String(e || ''));
  return t && EMOTION_TAGS.includes(t) ? t : null;
}
interface Script {
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
  visualStyle: string;
  characters: string;
  scenes: Scene[];
  usedFallbackTemplate: boolean;
  model?: string;
  aiError?: string;
  sources?: string[];
  sourceHeadline?: string;
}

// ---------------------------------------------------------------------------
// Script writer pool: Gemini (keys rotated per run, instant failover) → Groq.
// An exhausted model is never retried in the same run (see llm.ts).
// ---------------------------------------------------------------------------
const LLM = new LlmPool({
  geminiKeys: CFG.geminiKeys,
  groqKeys: CFG.groqKeys,
  geminiModels: CFG.geminiModels,
  groqModels: CFG.groqModels,
  geminiBase: CFG.geminiBase,
  groqBase: CFG.groqBase,
  log: (m) => log(m),
  seed: parseInt(crypto.createHash('md5').update(`${CFG.campaignId}:${CFG.partNumber}:${CFG.runId}`).digest('hex').slice(0, 6), 16)
});

function stripTags(s: string): string {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Loose key for "is this the same story?" comparisons. */
const storyKey = (t: string) => String(t || '').toLowerCase().replace(/\s+-\s+[^-]+$/, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 8).sort().join(' ');
function sameStory(a: string, b: string): boolean {
  const A = new Set(storyKey(a).split(' ')), B = storyKey(b).split(' ');
  if (!A.size || !B.length) return false;
  const shared = B.filter((w) => A.has(w)).length;
  return shared >= Math.max(3, Math.ceil(Math.min(A.size, B.length) * 0.6));
}

/** Real, recent headlines for tech/news — freshest first, never one we already covered. */
async function recentHeadlines(pastTitles: string[], pastSources: string[]): Promise<{ title: string; source: string; date: string; link: string }[]> {
  if (CFG.offline) return [];
  const topicBySub: Record<string, string> = {
    'latest smartphone': 'smartphone launch', 'ai reasoning models': 'new AI model released', 'silicon & processors': 'new processor chip announced',
    gadgets: 'new gadget launch', 'ai tools': 'new AI tool launched', world: 'world news', 'business & money': 'business news', 'science & health': 'science discovery',
    entertainment: 'entertainment news', sports: 'sports news'
  };
  const base = CFG.topic || topicBySub[CFG.subGenre.toLowerCase()] || (CFG.category === 'tech' ? 'new AI tool launched' : 'breaking news');
  const seen = [...pastTitles, ...pastSources, ...CFG.usedHeadlines];
  const items: { title: string; source: string; date: string; link: string; ts: number }[] = [];
  // Freshest window first; widen only if everything recent was already covered.
  for (const window of CFG.category === 'news' ? ['when:1d', 'when:2d', 'when:4d'] : ['when:2d', 'when:5d', 'when:10d']) {
    const url = `${CFG.newsBase}?q=${encodeURIComponent(`${base} ${window}`)}&hl=en-US&gl=US&ceid=US:en`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 AnimatoAutoPoster/4.0' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const block = m[1];
        const title = stripTags((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
        const source = stripTags((block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
        const date = stripTags((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
        const link = stripTags((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
        if (!title) continue;
        const clean = source && title.endsWith(` - ${source}`) ? title.slice(0, -(source.length + 3)) : title;
        if (seen.some((s) => sameStory(s, clean)) || items.some((x) => sameStory(x.title, clean))) continue;
        items.push({ title: clean, source, date, link, ts: Date.parse(date) || 0 });
      }
    } catch (err: any) {
      log(`Headline lookup failed (${err?.message}).`);
    }
    if (items.length >= 6) break;
  }
  items.sort((a, b) => b.ts - a.ts);
  log(`Found ${items.length} fresh headlines for "${base}" (skipped anything already covered).`);
  return items.slice(0, 10).map(({ ts, ...h }) => h);
}

function lengthSpec() {
  return IS_SHORTS
    ? { words: '135-165', minWords: 110, maxWords: 190, scenes: '7-10', minScenes: 5, maxScenes: 12, seconds: 'about 55-60 seconds' }
    : { words: '360-460', minWords: 280, maxWords: 520, scenes: '16-24', minScenes: 12, maxScenes: 28, seconds: 'about 2.5-3 minutes' };
}

function categoryBrief(pastStory: string, headlines: { title: string; source: string; date: string }[]): string {
  const topic = CFG.topic ? `\nCreator's direction: "${CFG.topic}".` : '';
  const sub = CFG.subGenre ? `\nSub-genre: ${CFG.subGenre}.` : '';
  const news = headlines.length
    ? `\nFRESH HEADLINES (newest first; none of these has been covered on this channel before). Use ONLY facts stated here — do not invent numbers, prices, specs, quotes, names or dates:\n${headlines.map((h, i) => `${i + 1}. ${h.title}${h.source ? ` (${h.source}${h.date ? `, ${h.date.slice(0, 16)}` : ''})` : ''}`).join('\n')}\nPick the single most important/interesting story (prefer #1-#3, the newest) and build the whole video around it. Mention the source naturally once. Put the exact headline you used in "sourceHeadline".`
    : '';
  switch (CFG.category) {
    case 'cooking':
      return `FORMAT: a narrated cooking tutorial${sub}${topic}
- Pick ONE specific, genuinely good dish (different from the previous videos listed below).
- Scene 1 is the HOOK: a mouth-watering promise or a surprising tip, max 14 words ("The secret to crispy fried rice is day-old rice, and here's why.").
- Then: ingredients with exact amounts, then clear step-by-step instructions with times/temperatures, one pro tip, and a satisfying final plating moment.
- End with a one-line call to action (ask a question viewers will answer in the comments).
- Use shot "panel" for ingredient and step scenes (the presenter points at the photo), "scene" for the hook and the final dish.
- imagePrompt: professional food photography of exactly that step (hands, pan, ingredients), appetising natural light, shallow depth of field.`;
    case 'tech':
      return `FORMAT: a tech / AI tool tutorial-review${sub}${topic}${news}
- Cover ONE real, newly released or trending AI tool, app, model or gadget${headlines.length ? ' from the headlines above' : ''}.
- Scene 1 is the HOOK (max 14 words): the most useful or surprising thing it does for the viewer ("This free AI tool turns a photo into a 3D model in seconds.").
- Then, tutorial style: WHAT it is (one line) → the problem it solves / who it helps → WHERE to get it (official website, app store or platform by name — never invent a URL) → HOW to use it in 3-5 concrete steps ("Open…", "Upload…", "Type a prompt like…", "Export…") → one pro tip → one honest limitation → a clear verdict.
- Talk like a friendly expert showing a friend, not an ad. Never state a spec, price, date or feature that is not in the headlines or widely known.
- Use shot "panel" for most scenes: the presenter points at the image of the tool/step.
- searchQuery: a real-photo query naming the actual product/company (e.g. "Pixel 10 Pro phone"). imagePrompt: a clean, modern illustration or UI-style screen of exactly that step (e.g. "a laptop screen showing an AI image generator with a prompt box, clean UI, soft studio light") — no brand logos, no readable text.${headlines.length ? '' : '\n- No headlines were available: pick a well-known, clearly real AI tool and stay factual.'}`;
    case 'news':
      return `FORMAT: a 60-second news explainer${sub}${topic}${news}
- Scene 1 is the HOOK: what happened, in max 14 words, in plain language.
- Then: the key facts (who, what, where, when), why it matters to the viewer, and what happens next. Neutral, accurate, no speculation, no opinions.
- It must be a story that is NOT in the list of previous video titles below.
- Use shot "panel" for fact scenes; searchQuery must name the real place/person/organisation/event for a real news photo.${headlines.length ? '' : '\n- No headlines were available: explain one important, well-established recent development without inventing details.'}`;
    default: {
      const tone = /horror|suspense|scary/i.test(CFG.subGenre) ? 'slow-building dread, grounded realism, sensory detail (sounds, cold air, shadows); scary, never gory'
        : /mystery/i.test(CFG.subGenre) ? 'a gripping mystery with clues the viewer can follow'
        : /twist/i.test(CFG.subGenre) ? 'a clean setup, subtle misdirection and a twist that recontextualises everything'
        : /love|romance/i.test(CFG.subGenre) ? 'warm, emotional, bittersweet and hopeful'
        : 'gripping, emotional, cinematic';
      const cont = pastStory
        ? `\nTHE STORY SO FAR:\n${pastStory}\nThis is Part ${CFG.partNumber}. Continue DIRECTLY from the last cliffhanger with the same characters (same names, same looks) and setting. No "previously on" recap; the hook itself pulls the viewer straight back in.`
        : `\nThis is Part 1 of a series: introduce ONE protagonist with a first name and ONE gripping situation.`;
      return `FORMAT: episodic short story told by a NARRATOR in the THIRD PERSON${sub}${topic}${cont}
- The presenter is the storyteller, NEVER a character in the story. Tell it about the characters by name: "This is the story of Anna. She lived alone above an old bakery…", "Marcus had never believed in luck. Then…". Use he/she/they and names — never "I", "me" or "my" for the protagonist. The narrator may speak to the viewer ("you") only for suspense or the final question.
- Tone: ${tone}.
- Scene 1 is the HOOK (max 16 words): an impossible detail or burning question about the protagonist that makes scrolling away impossible ("Anna's sister died three years ago. Tonight, Anna's phone lit up with her name.").
- Keep it engaging EVERY scene: open a question, pay it off, open a bigger one. Concrete sensory details, rising stakes, no filler, no summarising.
- Structure: hook → quick setup (who, where, what feels wrong) → 2-4 escalating beats → a cliffhanger that raises one urgent question, teasing Part ${CFG.partNumber + 1}.
- Short, spoken sentences, past tense. Every scene must move the story forward and make sense.
- Use shot "scene" for most scenes, "full" for the 1-2 most dramatic reveals, "panel" only for a key object/clue close-up.
- "characters": a fixed visual description of each named character (age, hair, clothes), reused in every imagePrompt that shows them.
- imagePrompt: a cinematic film still of EXACTLY what that scene describes — who (named character + their fixed description), where (the specific place), what is happening at that moment, lighting, camera angle. No text in the image.
- Title must end with "(Part ${CFG.partNumber})".`;
    }
  }
}

function buildPrompt(pastStory: string, pastTitles: string[], headlines: any[]): string {
  const L = lengthSpec();
  const avoid = pastTitles.length ? `\nPrevious video titles (do NOT repeat these topics): ${pastTitles.slice(-15).join(' | ')}` : '';
  return `You are writing a ${IS_SHORTS ? 'YouTube Short (vertical)' : 'YouTube video (16:9)'} of ${L.seconds}, narrated by an animated presenter.
${categoryBrief(pastStory, headlines)}${avoid}

RULES
- Total narration: ${L.words} words across ${L.scenes} scenes. Each scene is 1-3 spoken sentences (8-40 words).
- Write for the ear: short sentences, concrete words, no emojis, no hashtags, no stage directions, no "In this video".
- Suitable for a general YouTube audience (PG-13): tension and mystery are great; no gore, no graphic violence, no self-harm, nothing sexual.
- Every scene gets its own image that shows exactly what is being said at that moment.

PERFORMANCE TAGS (the presenter is an animated character with a face, head, arms and hands; it performs tags you write INSIDE "narration")
- Put a tag right before the word where the change should land. Tags are never spoken or shown as captions.
- Emotion tags (the face keeps it until the next emotion tag): [neutral] [calm] [happy] [excited] [curious] [serious] [worried] [scared] [surprised] [sad] [crying] [angry] [laugh]
- Head/eye tags: [look_image] turn and look at the picture, [look_left] [look_right] glance aside, [look_up], [think] ponder, [nod], [shake_head], [lean_in] for a secret or key point.
- Hand/body tags: [point] point at the picture on screen, [explain] open-palm explaining gesture, [count] hold up a finger for a step or item, [wave] wave hello/goodbye, [shrug] "who knows?", [hands_up] "whoa!", [hand_chest] heartfelt/sad, [fist] determined/emphasis.
- Start EVERY scene with an emotion tag and change emotion whenever the feeling of the words changes, exactly like a real presenter. Use [laugh] only for genuinely funny moments and [crying] only for truly heartbreaking ones.
- Example: "[serious] Heavy rain flooded the coast overnight. [point] This is Main Street this morning. [happy] But the good news? [nod] The weekend looks sunny." / tutorial: "[explain] First, open the app. [count] Step one: upload your photo."
- Use 2-4 tags per scene overall, including a hand/body tag in most scenes; [point] or [look_image] whenever the words refer to what is on screen; [wave] in the first or last scene. Never use a tag that contradicts the words.

YOUTUBE PACKAGING
- "title": max 70 characters, curiosity + the main keyword, honest (no false clickbait), Title Case.
- "description": 2-3 sentences: a hook line, what the viewer gets, and a question inviting comments.
- "hashtags": 3-5 specific lowercase hashtags without "#" that real viewers search (e.g. "scarystories", "horrorstory", "creepypasta"), never generic filler like "viral" or "fyp".
- "tags": 8-15 search phrases.

Return ONLY this JSON (no markdown):
{
  "title": "...",
  "description": "...",
  "hashtags": ["..."],
  "tags": ["..."],
  "visualStyle": "one consistent look for every image, e.g. 'dark cinematic film still, cold blue shadows, 35mm, moody practical lighting'",
  "characters": "fixed physical description of each recurring named person for consistent images (or empty)",
  "sourceHeadline": "the exact headline used (tech/news only, else empty)",
  "scenes": [
    { "narration": "[emotion] spoken words with [gesture] tags where they land", "shot": "scene|panel|full", "emotion": "main emotion of the scene", "imagePrompt": "...", "searchQuery": "3-6 word real-photo search query" }
  ]
}`;
}

/** Same request in softer words, for providers whose moderation flags horror/crime vocabulary. */
function saferScriptPrompt(p: string): string {
  const swaps: [RegExp, string][] = [
    [/\b(blood(y|ied)?|gore|gory|guts|bleeding)\b/gi, 'dark'],
    [/\b(corpse|dead body|cadaver)\b/gi, 'shadowy figure'],
    [/\b(murder(ed|er|ing|s)?|kill(ed|er|ing|s)?|slaughter(ed)?|stab(bed|bing)?|strangl(ed|ing))\b/gi, 'crime'],
    [/\b(suicide|self-harm)\b/gi, 'loss'],
    [/\b(knife|knives|gun|pistol|rifle|weapon|axe|machete)\b/gi, 'object'],
    [/\b(demon(ic)?|possessed|satanic)\b/gi, 'unexplained'],
    [/\b(naked|nude)\b/gi, 'alone'],
    [/\b(torture(d)?|gruesome|mutilat\w*)\b/gi, 'terrible']
  ];
  let out = p;
  for (const [re, to] of swaps) out = out.replace(re, to);
  return `${out}

SAFE MODE: write it for a general audience (PG-13). Suspense, mystery and emotion only — no gore, no graphic violence, no self-harm, nothing sexual, no real people.`;
}

const extractJson = extractJsonObject;

function cleanHashtag(h: any): string {
  return String(h || '').toLowerCase().replace(/^#/, '').replace(/[^a-z0-9]/g, '').slice(0, 30);
}

const DEFAULT_TAGS: Record<string, string[]> = {
  stories: ['storytime', 'scarystories', 'horrorstory', 'creepy'],
  cooking: ['recipe', 'cooking', 'easyrecipe', 'foodie'],
  tech: ['tech', 'technews', 'gadgets', 'ai'],
  news: ['news', 'breakingnews', 'worldnews', 'explained']
};

function normaliseScript(parsed: any, model: string, relaxed = false): Script {
  const L = { ...lengthSpec() };
  if (relaxed) { L.minScenes = Math.ceil(L.minScenes * 0.6); L.minWords = Math.ceil(L.minWords * 0.65); }
  const scenes: Scene[] = (Array.isArray(parsed.scenes) ? parsed.scenes : [])
    .map((s: any) => {
      const tagged = parseTaggedNarration(String(s?.narration || s?.text || ''));
      return {
        narration: tagged.text,
        cues: tagged.cues,
        shot: (['scene', 'panel', 'full'].includes(String(s?.shot)) ? s.shot : 'scene') as Scene['shot'],
        emotion: String(s?.emotion || 'neutral').toLowerCase().slice(0, 20),
        imagePrompt: String(s?.imagePrompt || s?.visual || '').trim().slice(0, 400),
        searchQuery: String(s?.searchQuery || '').replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
      };
    })
    .filter((s: Scene) => s.narration.split(' ').length >= 3);
  const words = scenes.reduce((n, s) => n + s.narration.split(' ').length, 0);
  if (scenes.length < L.minScenes) throw new Error(`only ${scenes.length} scenes`);
  if (words < L.minWords) throw new Error(`script too short (${words} words)`);
  // Trim an over-long script at a scene boundary (keeps timing within the format).
  while (scenes.length > L.minScenes && scenes.reduce((n, s) => n + s.narration.split(' ').length, 0) > L.maxWords) scenes.splice(scenes.length - 2, 1);
  if (scenes.length > L.maxScenes) scenes.splice(L.maxScenes - 1, scenes.length - L.maxScenes);
  let title = String(parsed.title || '').replace(/[#"]/g, '').replace(/\s+/g, ' ').trim();
  if (!title) title = scenes[0].narration.slice(0, 60);
  if (CFG.category === 'stories' && !/\(part \d+\)/i.test(title)) title = `${title.slice(0, 58)} (Part ${CFG.partNumber})`;
  let hashtags = Array.from(new Set((Array.isArray(parsed.hashtags) ? parsed.hashtags : []).map(cleanHashtag).filter((h: string) => h.length >= 3 && !/^(viral|fyp|foryou|trending|shorts)$/.test(h))));
  for (const d of DEFAULT_TAGS[CFG.category] || DEFAULT_TAGS.stories) if (hashtags.length < 3 && !hashtags.includes(d)) hashtags.push(d);
  hashtags = hashtags.slice(0, 5);
  const tags = Array.from(new Set([...(Array.isArray(parsed.tags) ? parsed.tags : []).map((t: any) => String(t).replace(/[<>#]/g, '').trim()).filter(Boolean), ...hashtags])).slice(0, 18);
  return {
    title: title.slice(0, 95),
    description: String(parsed.description || '').replace(/#\w+/g, '').trim().slice(0, 1200),
    hashtags,
    tags,
    visualStyle: String(parsed.visualStyle || '').slice(0, 200),
    characters: String(parsed.characters || '').slice(0, 300),
    scenes,
    usedFallbackTemplate: false,
    model,
    sourceHeadline: String(parsed.sourceHeadline || '').slice(0, 300)
  };
}

async function generateScript(pastStory: string, pastTitles: string[], pastSources: string[]): Promise<Script> {
  const headlines = (CFG.category === 'tech' || CFG.category === 'news') ? await recentHeadlines(pastTitles, pastSources) : [];
  const prompt = buildPrompt(pastStory, pastTitles, headlines);
  const system = 'You are an award-winning short-form video writer and director. Your videos open with an irresistible hook, make complete sense, stay engaging every single second and end with a reason to follow. You answer with one valid JSON object and nothing else.';
  let nearMiss: { script: Script; words: number } | null = null;
  let lastError = '';
  const withSources = (sc: Script) => {
    const used = headlines.find((h) => sc.sourceHeadline && sameStory(h.title, sc.sourceHeadline)) || (headlines.length ? headlines.find((h) => sc.scenes.some((x) => sameStory(h.title, x.narration))) : null);
    sc.sources = (used ? [used] : headlines.slice(0, 1)).map((h) => `${h.title} (${h.source})`);
    return sc;
  };
  if (!CFG.offline && !LLM.hasKeys) throw new PipelineError('script_failed', 'No Gemini or Groq API key was provided to the runner.');
  if (!CFG.offline) {
    log(`Script writer: ${CFG.geminiKeys.length} Gemini key(s) → ${CFG.groqKeys.length} Groq key(s) as fallback.`);
    const t0 = Date.now();
    for await (const a of LLM.attempts({
      system,
      user: prompt,
      saferUser: saferScriptPrompt(prompt),
      temperature: CFG.category === 'stories' ? 0.95 : 0.7,
      maxTokens: IS_SHORTS ? 6000 : 10000,
      json: true,
      timeoutMs: 100000
    })) {
      const label = `${a.provider}/${a.model}`;
      try {
        const parsed = extractJson(a.text);
        let script: Script;
        try {
          script = normaliseScript(parsed, label);
        } catch (validation: any) {
          try {
            const near = normaliseScript(parsed, label, true);
            const words = near.scenes.reduce((n, x) => n + x.narration.split(' ').length, 0);
            if (!nearMiss || words > nearMiss.words) nearMiss = { script: near, words };
          } catch {}
          throw validation;
        }
        withSources(script);
        log(`Script by ${label} in ${((Date.now() - t0) / 1000).toFixed(1)}s: "${script.title}" — ${script.scenes.length} scenes, ${script.scenes.reduce((n, x) => n + x.narration.split(' ').length, 0)} words, ${script.scenes.reduce((n, x) => n + x.cues.length, 0)} performance cues.`);
        return script;
      } catch (err: any) {
        lastError = `${label}: ${err?.message}`;
        log(`${label} answered but the script was unusable (${err?.message}) — asking the next model.`);
      }
    }
    if (!lastError) lastError = LLM.lastErrors.slice(-3).join(' | ') || 'no model answered';
  } else {
    lastError = 'offline test mode';
  }
  if (nearMiss) {
    log(`Using the best AI script (${nearMiss.words} words — a little shorter than asked) from ${nearMiss.script.model}.`);
    return withSources(nearMiss.script);
  }
  log(`⚠️ AI script generation failed (${lastError}).`);
  return { ...templateScript(), aiError: lastError };
}

function templateScript(): Script {
  const s = (narration: string, shot: Scene['shot'], emotion: string, imagePrompt: string, searchQuery: string): Scene => {
    const tagged = parseTaggedNarration(narration);
    return { narration: tagged.text, cues: tagged.cues, shot, emotion, imagePrompt, searchQuery };
  };
  const nora = 'Nora, a woman in her thirties with short dark hair and a yellow raincoat';
  return {
    title: `The Lighthouse Signal (Part ${CFG.partNumber})`,
    description: 'An episodic mystery told in parts. What would you do next?',
    hashtags: ['scarystories', 'mystery', 'storytime'],
    tags: ['scary story', 'mystery story', 'lighthouse'],
    visualStyle: 'dark cinematic film still, cold blue shadows, 35mm, moody lighting',
    characters: nora,
    usedFallbackTemplate: true,
    scenes: [
      s('[serious] For seventy years, nobody had kept the lighthouse on Blackwood Point. [surprised] Then one night, its light came on.', 'scene', 'tense', 'an old stone lighthouse on a cliff at night, its lamp glowing blue through thick fog', 'lighthouse fog night'),
      s('[worried] This is the story of Nora, [look_left] the only person in town who went up to look.', 'scene', 'tense', `${nora} walking up a foggy cliff path at night with a flashlight`, 'foggy cliff path night'),
      s('[serious] The rusted door was already open. [lean_in] Inside, the air smelled of salt and old stone.', 'scene', 'scared', 'a rusted iron door hanging open at the base of a lighthouse, darkness inside', 'old rusted door dark'),
      s('[worried] On the spiral stairs, [point] Nora found footprints. Fresh. Still wet. [scared] Going up.', 'panel', 'scared', 'wet footprints on old stone spiral stairs lit by a flashlight beam', 'spiral staircase stone'),
      s('[scared] Every step she climbed echoed twice, [look_up] as if someone above her was climbing too.', 'scene', 'scared', `${nora} looking up a narrow spiral staircase into darkness, flashlight beam`, 'spiral staircase looking up'),
      s('[surprised] At the top, the great glass lens was turning on its own, [hands_up] humming like it was alive.', 'full', 'shocked', 'a huge glowing lighthouse lens turning in a dark lantern room', 'lighthouse lens'),
      s('[serious] Scratched into the glass, in fresh sharp letters, was that night\'s date. [scared] And Nora\'s name.', 'full', 'shocked', 'letters scratched into glass, close up, eerie blue light', 'scratched glass close up'),
      s('[worried] Someone knew she would come. [calm] Part two is next. [curious] Would you have climbed those stairs? [wave]', 'scene', 'tense', `${nora} frozen in a dark lantern room, blue light on her face`, 'woman dark room blue light')
    ]
  };
}

// ---------------------------------------------------------------------------
// 2. Narration with word timings
// ---------------------------------------------------------------------------
interface Word { text: string; start: number; end: number; token?: number }
interface Narration { audioPath: string; duration: number; words: Word[]; wordsReliable: boolean; engine: string; neural: boolean }

const VOICES: Record<string, Record<string, string[]>> = {
  female: {
    stories: ['en-US-AvaMultilingualNeural', 'en-US-EmmaMultilingualNeural', 'en-US-AriaNeural'],
    news: ['en-US-EmmaMultilingualNeural', 'en-US-AriaNeural', 'en-US-JennyNeural'],
    default: ['en-US-AvaMultilingualNeural', 'en-US-JennyNeural', 'en-US-AriaNeural']
  },
  male: {
    stories: ['en-US-AndrewMultilingualNeural', 'en-US-ChristopherNeural', 'en-US-GuyNeural'],
    news: ['en-US-BrianMultilingualNeural', 'en-US-GuyNeural', 'en-US-ChristopherNeural'],
    default: ['en-US-AndrewMultilingualNeural', 'en-US-BrianMultilingualNeural', 'en-US-GuyNeural']
  }
};
const RATE: Record<string, string> = { stories: '-3%', cooking: '+4%', tech: '+5%', news: '+5%' };

function cleanForSpeech(text: string): string {
  return text.replace(/[*_#`>~]/g, ' ').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Attach the script's own tokens (with punctuation) to the TTS word timings. */
function alignWords(boundaries: Word[], script: string): Word[] {
  const tokens = script.split(/\s+/).filter(Boolean);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const out: Word[] = [];
  let ti = 0;
  for (const b of boundaries) {
    const nb = norm(b.text);
    if (!nb) continue;
    let found = -1;
    for (let k = ti; k < Math.min(tokens.length, ti + 6); k++) {
      const nt = norm(tokens[k]);
      if (nt && (nt === nb || nt.startsWith(nb) || nb.startsWith(nt))) { found = k; break; }
    }
    if (found >= 0) {
      // A token already consumed (e.g. "1/2" spoken as several words): extend the last word instead.
      out.push({ text: tokens[found], start: b.start, end: b.end, token: found });
      ti = found + 1;
    } else if (out.length && out[out.length - 1].token === ti - 1) {
      out[out.length - 1].end = b.end;
    } else {
      out.push({ text: b.text, start: b.start, end: b.end, token: -1 });
    }
  }
  return out;
}

let LAST_TTS_ERROR = '';

async function synthesizeNarration(script: string): Promise<Narration> {
  const text = cleanForSpeech(script);
  const textFile = path.join(WORK_DIR, 'script.txt');
  fs.writeFileSync(textFile, text);
  const python = ENV.PYTHON || 'python3';
  const voices = (VOICES[CFG.gender][CFG.category] || VOICES[CFG.gender].default);

  let lastTtsError = '';
  if (!CFG.offline) {
    // Each voice at the category's pace, then at normal pace; short pause between
    // attempts so a transient Edge TTS hiccup does not cost the run.
    const attempts: { voice: string; rate: string }[] = [];
    for (const voice of voices) attempts.push({ voice, rate: RATE[CFG.category] || '+0%' });
    attempts.push({ voice: voices[0], rate: '+0%' }, { voice: voices[1] || voices[0], rate: '+0%' });
    for (let a = 0; a < attempts.length; a++) {
      const { voice, rate } = attempts[a];
      if (a > 0) await sleep(Math.min(8000, 2000 * a));
      const mp3 = path.join(WORK_DIR, 'narration.mp3');
      const wordsFile = path.join(WORK_DIR, 'words.json');
      for (const f of [mp3, wordsFile]) { try { fs.unlinkSync(f); } catch {} }
      // "--rate=-3%" (with "="): a value starting with "-" would otherwise be read as a new option.
      const r = await run(python, [path.join(HERE, 'tts.py'), `--text-file=${textFile}`, `--voice=${voice}`, `--rate=${rate}`, `--out-audio=${mp3}`, `--out-words=${wordsFile}`], { timeoutMs: 180000 });
      const duration = fs.existsSync(mp3) ? await probeDuration(mp3) : 0;
      if (r.code === 0 && duration > 2) {
        let words: Word[] = [];
        let reliable = false;
        try {
          const data = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
          if (Array.isArray(data.words) && data.words.length > 5) {
            words = alignWords(data.words, text);
            reliable = true;
          }
        } catch {}
        if (!reliable) words = estimateWordTimes(text, duration);
        log(`Narration: ${voice}, ${duration.toFixed(1)}s, ${words.length} timed words${reliable ? '' : ' (estimated)'}.`);
        return { audioPath: mp3, duration, words, wordsReliable: reliable, engine: `edge-tts:${voice}`, neural: true };
      }
      lastTtsError = r.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' | ') || `exit ${r.code}`;
      log(`edge-tts with ${voice} (${rate}) failed (exit ${r.code}): ${lastTtsError}`);
    }
  }
  LAST_TTS_ERROR = lastTtsError;

  // Offline fallback: ffmpeg's built-in flite voice.
  const wav = path.join(WORK_DIR, 'narration_flite.wav');
  const voice = CFG.gender === 'male' ? 'kal16' : 'slt';
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `flite=textfile=${textFile}:voice=${voice}`, '-ar', '44100', '-ac', '1', wav], { timeoutMs: 120000 });
  const duration = fs.existsSync(wav) ? await probeDuration(wav) : 0;
  if (r.code !== 0 || duration < 1) throw new PipelineError('tts_failed', `Voice synthesis failed with every engine. ${r.stderr.slice(-300)}`);
  log(`⚠️ Neural voice unavailable — used the offline flite voice (${duration.toFixed(1)}s).`);
  return { audioPath: wav, duration, words: estimateWordTimes(text, duration), wordsReliable: false, engine: `flite:${voice}`, neural: false };
}

function estimateWordTimes(text: string, duration: number): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const weight = (t: string) => Math.max(1, t.replace(/[^a-z]/gi, '').length) + (/[.!?]$/.test(t) ? 5 : /[,;:]$/.test(t) ? 2 : 0);
  const total = tokens.reduce((n, t) => n + weight(t), 0) || 1;
  const span = Math.max(0.5, duration - 0.3);
  let t = 0.15;
  return tokens.map((tok, i) => {
    const d = (weight(tok) / total) * span;
    const w = { text: tok, start: t, end: t + d * 0.85, token: i };
    t += d;
    return w;
  });
}

/** Scene start/end times from where each scene's first word is actually spoken. */
function timeScenes(scenes: Scene[], words: Word[], duration: number): { start: number; end: number }[] {
  const counts = scenes.map((s) => cleanForSpeech(s.narration).split(/\s+/).filter(Boolean).length);
  const starts: number[] = [];
  let tokenStart = 0;
  for (let i = 0; i < scenes.length; i++) {
    const w = words.find((x) => (x.token ?? -1) >= tokenStart);
    starts.push(i === 0 ? 0 : Math.max(0, (w ? w.start : duration * (tokenStart / Math.max(1, counts.reduce((a, b) => a + b, 0)))) - 0.12));
    tokenStart += counts[i];
  }
  const total = duration;
  return scenes.map((_, i) => ({ start: starts[i], end: i + 1 < scenes.length ? starts[i + 1] : total }));
}

// ---------------------------------------------------------------------------
// 3. Images — one per scene
// ---------------------------------------------------------------------------
async function download(url: string, file: string, timeoutMs = 45000, headers: Record<string, string> = {}): Promise<boolean> {
  try {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      fs.writeFileSync(file, url.slice(0, comma).includes('base64') ? Buffer.from(url.slice(comma + 1), 'base64') : Buffer.from(decodeURIComponent(url.slice(comma + 1))));
    } else {
      const res = await fetch(url, { headers: { 'User-Agent': 'AnimatoAutoPoster/3.0 (+https://github.com)', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return false;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 4000) return false;
      fs.writeFileSync(file, buf);
    }
    const [w, h] = await imageSize(file);
    return w >= 320 && h >= 320;
  } catch {
    return false;
  }
}

/** Normalise any downloaded image to a JPEG the stage can decode quickly. */
async function toJpeg(src: string, dst: string, cropBottom = 0): Promise<boolean> {
  const vf = [cropBottom > 0 ? `crop=iw:ih*${(1 - cropBottom).toFixed(3)}:0:0` : '', "scale='min(1920,iw)':-2"].filter(Boolean).join(',');
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '3', dst], { timeoutMs: 60000 });
  return r.code === 0 && fs.existsSync(dst);
}

const orientation = W > H * 1.2 ? 'landscape' : H > W * 1.2 ? 'portrait' : 'square';
let lastPollinationsAt = 0;

// NVIDIA NIM (build.nvidia.com): FLUX text-to-image. The hosted API may only
// accept 1024x1024; we ask for the video's shape first and remember if it is refused.
let nvidiaDisabled = '';
let nvidiaSquareOnly = false;
let nvidiaCount = 0;
const NVIDIA_MODELS = [
  { id: 'black-forest-labs/flux.1-dev', body: { mode: 'base', cfg_scale: 3.5, steps: 28, samples: 1 } },
  { id: 'black-forest-labs/flux.1-schnell', body: { mode: 'base', cfg_scale: 0, steps: 4, samples: 1 } }
];

/** Tone a prompt down for safety filters (horror/crime scenes) while keeping the scene. */
function softenPrompt(p: string): string {
  const swaps: [RegExp, string][] = [
    [/\b(blood(y|ied)?|gore|gory|guts|wound(s|ed)?|bleeding)\b/gi, 'dark stains'],
    [/\b(corpse|dead body|body bag|cadaver|remains)\b/gi, 'silhouette'],
    [/\b(murder(ed|er|ing)?|kill(ed|er|ing|s)?|slaughter(ed)?|stab(bed|bing)?|strangl(ed|ing))\b/gi, 'mystery'],
    [/\b(knife|knives|gun|pistol|rifle|weapon|axe|machete)\b/gi, 'shadowy object'],
    [/\b(demon(ic)?|possessed|satanic|occult)\b/gi, 'eerie'],
    [/\b(naked|nude|undressed)\b/gi, 'dressed'],
    [/\b(scream(ing|ed)?|terrified|horrif(ied|ying)|gruesome|disturbing)\b/gi, 'tense'],
    [/\b(child|girl|boy|kid)\b/gi, 'person']
  ];
  let out = p;
  for (const [re, to] of swaps) out = out.replace(re, to);
  return `${out}. Atmospheric, suspenseful, tasteful, no violence, no gore, cinematic lighting`;
}

async function nvidiaImage(prompt: string, seed: number, file: string): Promise<boolean> {
  if (!CFG.nvidiaKey || nvidiaDisabled) return false;
  let softened = false;
  const shaped = orientation === 'portrait' ? { width: 768, height: 1344 } : orientation === 'landscape' ? { width: 1344, height: 768 } : { width: 1024, height: 1024 };
  for (const model of NVIDIA_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const size = nvidiaSquareOnly ? { width: 1024, height: 1024 } : shaped;
      const framing = size.width === size.height && orientation !== 'square' ? ', centered composition with the main subject in the middle of the frame' : '';
      let res: Response;
      try {
        res = await fetch(`${CFG.nvidiaBase}/${model.id}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${CFG.nvidiaKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ prompt: ((softened ? softenPrompt(prompt) : prompt) + framing).slice(0, 2000), ...size, seed: seed % 4294967295, ...model.body }),
          signal: AbortSignal.timeout(120000)
        });
      } catch (err: any) {
        log(`NVIDIA ${model.id} request failed (${err?.message}).`);
        break; // next model
      }
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        nvidiaDisabled = `HTTP ${res.status}`;
        log(`⚠️ The NVIDIA API key was rejected (HTTP ${res.status}) — using other image sources for this run.`);
        return false;
      }
      if (res.status === 422 && !nvidiaSquareOnly && (size.width !== 1024 || size.height !== 1024)) {
        nvidiaSquareOnly = true; // this endpoint only takes 1024x1024
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(2500 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        log(`NVIDIA ${model.id}: HTTP ${res.status} ${text.slice(0, 160)}`);
        break;
      }
      let data: any = {};
      try { data = JSON.parse(text); } catch {}
      const art = Array.isArray(data?.artifacts) ? data.artifacts[0] : null;
      const b64 = art?.base64 || data?.image || data?.b64_json || data?.data?.[0]?.b64_json;
      const finish = String(art?.finishReason || art?.finish_reason || data?.finish_reason || 'SUCCESS').toUpperCase();
      if (!b64 || (finish !== 'SUCCESS' && finish !== 'STOP')) {
        if (/FILTER|SAFETY|MODERAT|BLOCK/.test(finish) && !softened) {
          softened = true; // retry this model with a toned-down prompt
          log(`NVIDIA ${model.id}: prompt filtered — retrying with a softer wording.`);
          continue;
        }
        log(`NVIDIA ${model.id}: no image (${finish}).`);
        break;
      }
      fs.writeFileSync(file, Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64'));
      const [w, h] = await imageSize(file);
      if (w >= 320 && h >= 320) { nvidiaCount++; return true; }
      break;
    }
  }
  return false;
}

/** 'ai' = anonymous Pollinations (bottom watermark cropped), 'ai-clean' = NVIDIA / keyed. */
let pollinationsGate: Promise<void> = Promise.resolve();

async function aiImage(prompt: string, seed: number, file: string): Promise<'ai' | 'ai-clean' | null> {
  if (CFG.offline || !prompt) return null;
  if (await nvidiaImage(prompt, seed, file)) return 'ai-clean';
  const size = orientation === 'portrait' ? { w: 864, h: 1536 } : orientation === 'landscape' ? { w: 1536, h: 864 } : { w: 1152, h: 1152 };
  const enc = encodeURIComponent(prompt.slice(0, 480));
  if (CFG.pollinationsKey) {
    const url = `https://gen.pollinations.ai/image/${enc}?model=flux&width=${size.w}&height=${size.h}&seed=${seed}&nologo=true&private=true`;
    if (await download(url, file, 90000, { Authorization: `Bearer ${CFG.pollinationsKey}` })) return 'ai-clean';
  }
  // Anonymous tier: about one request every 15 s (serialised across parallel workers).
  const turn = pollinationsGate.then(async () => {
    const wait = lastPollinationsAt + 15500 - Date.now();
    if (wait > 0) await sleep(wait);
    lastPollinationsAt = Date.now();
  });
  pollinationsGate = turn.catch(() => {});
  await turn;
  const url = `https://image.pollinations.ai/prompt/${enc}?model=flux&width=${size.w}&height=${size.h}&seed=${seed}&nologo=true&private=true`;
  return (await download(url, file, 90000)) ? 'ai' : null;
}

async function stockImage(query: string, file: string): Promise<'stock' | null> {
  if (CFG.offline || !query) return null;
  const q = encodeURIComponent(query);
  const orient = orientation === 'portrait' ? 'portrait' : orientation === 'landscape' ? 'landscape' : 'square';
  const candidates: string[] = [];
  const tryJson = async (url: string, headers: Record<string, string> = {}) => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'AnimatoAutoPoster/3.0 (+https://github.com)', ...headers }, signal: AbortSignal.timeout(20000) });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  };
  if (CFG.pexelsKey) {
    const d: any = await tryJson(`https://api.pexels.com/v1/search?query=${q}&per_page=6&orientation=${orient}`, { Authorization: CFG.pexelsKey });
    for (const p of d?.photos || []) candidates.push(orientation === 'portrait' ? p.src?.portrait || p.src?.large2x : p.src?.large2x || p.src?.large);
  }
  if (CFG.pixabayKey && candidates.length < 2) {
    const d: any = await tryJson(`https://pixabay.com/api/?key=${CFG.pixabayKey}&q=${q}&image_type=photo&safesearch=true&per_page=6&orientation=${orientation === 'landscape' ? 'horizontal' : 'vertical'}`);
    for (const h of d?.hits || []) candidates.push(h.largeImageURL);
  }
  if (candidates.length < 2) {
    const d: any = await tryJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=6&gsrsearch=${q}%20filetype:bitmap&prop=imageinfo&iiprop=url|size&iiurlwidth=1600`);
    const pages = Object.values(d?.query?.pages || {}).sort((a: any, b: any) => (a.index || 0) - (b.index || 0)) as any[];
    for (const p of pages) { const ii = p?.imageinfo?.[0]; if (ii && (ii.width || 0) >= 800) candidates.push(ii.thumburl || ii.url); }
  }
  if (candidates.length < 2) {
    const d: any = await tryJson(`https://api.openverse.org/v1/images/?q=${q}&page_size=8&mature=false&aspect_ratio=${orientation === 'portrait' ? 'tall' : orientation === 'landscape' ? 'wide' : 'square'}`);
    for (const r of d?.results || []) if ((r.width || 0) >= 800) candidates.push(r.url);
  }
  for (const url of candidates.filter(Boolean).slice(0, 6)) {
    if (await download(url, file, 30000)) return 'stock';
  }
  return null;
}

/** The fixed look of every named character who appears in this scene (keeps people consistent across images). */
function castFor(script: Script, scene: Scene): string {
  if (!script.characters) return '';
  const parts = script.characters.split(/[;\n]+|\.\s+(?=[A-Z][a-z]+[:,( ])/).map((x) => x.trim()).filter(Boolean);
  const text = `${scene.imagePrompt} ${scene.narration}`.toLowerCase();
  const hits = parts.filter((p) => {
    const name = (p.match(/^([A-Z][a-zA-Z'-]+)/) || [])[1];
    return name ? text.includes(name.toLowerCase()) : false;
  });
  if (hits.length) return `Characters: ${hits.join('; ')}`;
  return CFG.category === 'stories' && parts.length === 1 && /\b(she|he|her|his|they)\b/.test(text) ? `Character: ${parts[0]}` : '';
}

async function gatherImages(script: Script): Promise<{ files: (string | null)[]; aiCount: number }> {
  const style = script.visualStyle || (CFG.category === 'cooking' ? 'professional food photography, natural light, shallow depth of field' : 'cinematic film still, dramatic lighting, 35mm');
  const realPhotosFirst = CFG.category === 'tech' || CFG.category === 'news';
  const seedBase = parseInt(crypto.createHash('md5').update(`${CFG.campaignId}:${CFG.partNumber}`).digest('hex').slice(0, 6), 16);
  const files: (string | null)[] = new Array(script.scenes.length).fill(null);
  let aiCount = 0;
  const deadline = Date.now() + (CFG.pollinationsKey || CFG.nvidiaKey ? 7 : 9) * 60 * 1000;

  // Test hook (never set in production): take scene images from a local folder.
  const testDir = ENV.ANIMATO_TEST_IMAGES_DIR;
  const testImages = testDir && fs.existsSync(testDir) ? fs.readdirSync(testDir).filter((n) => /\.(jpe?g|png|webp)$/i.test(n)).sort() : [];

  const fetchOne = async (i: number) => {
    const s = script.scenes[i];
    const raw = path.join(WORK_DIR, `scene_${i}.raw`);
    const out = path.join(WORK_DIR, `scene_${i}.jpg`);
    if (testImages.length) {
      if (await toJpeg(path.join(testDir!, testImages[i % testImages.length]), out)) files[i] = out;
      return;
    }
    const prompt = [s.imagePrompt || s.narration, castFor(script, s), CFG.category === 'stories' ? `The moment: ${s.narration.slice(0, 220)}` : '', style, 'photorealistic detail, no text, no watermark, no captions'].filter(Boolean).join('. ');
    const order = realPhotosFirst ? ['stock', 'ai'] : ['ai', 'stock'];
    for (const source of order) {
      if (Date.now() > deadline) break;
      const got = source === 'ai' ? await aiImage(prompt, seedBase + i * 7, raw) : await stockImage(s.searchQuery || s.imagePrompt.split(',')[0], raw);
      if (got && await toJpeg(raw, out, got === 'ai' ? 0.04 : 0)) {
        files[i] = out;
        if (got === 'ai' || got === 'ai-clean') aiCount++;
        return;
      }
    }
  };

  if (realPhotosFirst || CFG.pollinationsKey || CFG.nvidiaKey) {
    // Stock searches and keyed AI (NVIDIA / Pollinations key) run in parallel.
    const queue = script.scenes.map((_, i) => i);
    await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await fetchOne(queue.shift()!); }));
  } else {
    // Anonymous AI images are rate-limited: go in order so early scenes are ready first.
    for (let i = 0; i < script.scenes.length; i++) await fetchOne(i);
  }

  // Scenes without an image reuse the nearest one so nothing is ever blank.
  for (let i = 0; i < files.length; i++) {
    if (files[i]) continue;
    for (let d = 1; d < files.length; d++) {
      const f = files[i - d] || files[i + d];
      if (f) { files[i] = f; break; }
    }
  }
  if (!files.some(Boolean)) {
    const grad = path.join(WORK_DIR, 'gradient.png');
    const colors = CFG.category === 'cooking' ? ['0x3b1d0f', '0x9a4a12'] : CFG.category === 'tech' ? ['0x061a2b', '0x0f4c75'] : ['0x0b0b1a', '0x3a1c4a'];
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=${colors[0]}:c1=${colors[1]}:x0=0:y0=0:x1=${W}:y1=${H}:nb_colors=2`, '-frames:v', '1', grad]);
    files.fill(grad);
  }
  log(`Images: ${files.filter(Boolean).length}/${files.length} scenes (${aiCount} AI-generated${nvidiaCount ? `, ${nvidiaCount} by NVIDIA FLUX` : ''}${nvidiaDisabled ? `; NVIDIA unavailable: ${nvidiaDisabled}` : ''}).`);
  return { files, aiCount };
}

// ---------------------------------------------------------------------------
// 4. Character rig from the app (the character designed in the editor)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 5. Render in headless Chrome with the app's engine (falls back to FFmpeg)
// ---------------------------------------------------------------------------
function findChrome(): string | null {
  const candidates = [ENV.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean) as string[];
  for (const dir of [path.join(os.homedir(), '.cache/ms-playwright'), '/opt/pw-browsers', path.join(os.homedir(), '.cache/puppeteer/chrome')]) {
    try {
      for (const d of fs.readdirSync(dir)) {
        for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome', `${d}/chrome-linux64/chrome`]) candidates.push(path.join(dir, d, sub));
      }
    } catch {}
  }
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

function musicTrack(): string {
  return CFG.category === 'cooking' ? 'motivation_inspirational.mp3'
    : CFG.category === 'tech' ? 'news_broadcast.mp3'
    : CFG.category === 'news' ? 'news_urgent.mp3'
    : /horror|scary|suspense/i.test(CFG.subGenre) ? 'scary_ominous.mp3'
    : /mystery/i.test(CFG.subGenre) ? 'mystery_suspense.mp3'
    : 'story_chill.mp3';
}

async function findMusic(): Promise<string | null> {
  const track = musicTrack();
  const local = [path.join(HERE, 'music', track), path.join(process.cwd(), 'public', 'audio', 'music', track)].find((c) => fs.existsSync(c));
  if (local) return local;
  if (CFG.appUrl && !CFG.offline) {
    const file = path.join(WORK_DIR, track);
    try {
      const res = await fetch(`${CFG.appUrl}/audio/music/${track}`, { signal: AbortSignal.timeout(30000) });
      if (res.ok) {
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        if ((await probeDuration(file)) > 1) return file;
      }
    } catch {}
  }
  return null;
}

/** Audio: narration + music that ducks under the voice. */
function audioArgs(narration: string, music: string | null, firstInput: number): { inputs: string[]; filter: string } {
  const inputs = ['-i', narration];
  if (music) inputs.push('-stream_loop', '-1', '-i', music);
  const v = firstInput, m = firstInput + 1;
  const filter = music
    ? `[${v}:a]aresample=48000,apad[vo];[vo]asplit=2[vox][side];[${m}:a]aresample=48000,volume=0.22[mus];[mus][side]sidechaincompress=threshold=0.02:ratio=7:attack=15:release=350[ducked];[vox][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`
    : `[${v}:a]aresample=48000,apad[aout]`;
  return { inputs, filter };
}

async function renderWithStage(opts: {
  narration: Narration; scenes: Scene[]; times: { start: number; end: number }[]; cues: { t: number; tag: string }[]; images: (string | null)[];
  title: string; badge: string; endCard: string; music: string | null; duration: number;
}): Promise<{ ok: boolean; character: string; reason?: string }> {
  const chrome = findChrome();
  if (!chrome) return { ok: false, character: 'none', reason: 'Chrome not found on the runner' };
  const stageJs = path.join(HERE, 'stage.js');
  if (!fs.existsSync(stageJs)) return { ok: false, character: 'none', reason: 'stage.js missing' };

  const audioExt = path.extname(opts.narration.audioPath) || '.mp3';
  const accent = CFG.category === 'cooking' ? '#FFB020' : CFG.category === 'tech' ? '#22D3EE' : CFG.category === 'news' ? '#FF4D4D' : '#FFD23F';
  const job = {
    width: W, height: H, fps: FPS, duration: opts.duration, category: CFG.category,
    title: opts.title, badge: opts.badge, endCard: opts.endCard, accent,
    audio: `/audio/narration${audioExt}`,
    words: opts.narration.words.map((w) => ({ text: w.text, start: +w.start.toFixed(3), end: +w.end.toFixed(3) })),
    wordsReliable: opts.narration.wordsReliable,
    segments: opts.scenes.map((s, i) => ({ start: opts.times[i].start, end: opts.times[i].end, text: s.narration, image: opts.images[i] ? `/img/${path.basename(opts.images[i]!)}` : null, shot: s.shot, emotion: s.emotion })),
    cues: opts.cues,
    // The presenter: the CSS character spec designed in the app (the stage draws it).
    characterSpec: CFG.characterSpec,
    gender: CFG.gender,
    format: CFG.format,
    fontUrl: '/font/Poppins-Bold.ttf'
  };

  const totalFrames = Math.ceil(opts.duration * FPS);
  const frameBytes = W * H * 4;
  const aud = audioArgs(opts.narration.audioPath, opts.music, 1);
  const ffArgs = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
    ...aud.inputs, '-filter_complex', aud.filter, '-map', '0:v', '-map', '[aout]',
    '-t', opts.duration.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', OUTPUT_VIDEO];
  const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d: Buffer) => { ffErr += d.toString(); if (ffErr.length > 20000) ffErr = ffErr.slice(-10000); });
  const ffDone = new Promise<number>((resolve) => ff.on('close', (code: number | null) => resolve(code ?? -1)));
  ff.stdin.on('error', () => {});

  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
  const serveFile = (res: any, file: string) => {
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  };

  let framesWritten = 0;
  let finished: ((r: { ok: boolean; reason?: string; character?: string }) => void) | null = null;
  const result = new Promise<{ ok: boolean; reason?: string; character?: string }>((resolve) => { finished = resolve; });
  let lastProgressReport = 0;
  let pageErrors = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);
    if (req.method === 'GET') {
      if (p === '/' || p === '/index.html') return serveFile(res, path.join(HERE, 'stage.html'));
      if (p === '/stage.js') return serveFile(res, stageJs);
      if (p === '/job.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(job)); return; }
      if (p === '/font/Poppins-Bold.ttf') return serveFile(res, path.join(HERE, 'assets/fonts/Poppins-Bold.ttf'));
      if (p.startsWith('/img/')) return serveFile(res, path.join(WORK_DIR, path.basename(p)));
      if (p.startsWith('/audio/narration')) return serveFile(res, opts.narration.audioPath);
      res.writeHead(404); res.end(); return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      if (p === '/frame') {
        if (body.length !== frameBytes) { res.writeHead(400); res.end(); return; }
        const ok = ff.stdin.write(body);
        framesWritten++;
        if (!ok) await new Promise((r) => ff.stdin.once('drain', r));
        res.writeHead(204); res.end();
        return;
      }
      let msg: any = {};
      try { msg = JSON.parse(body.toString() || '{}'); } catch {}
      res.writeHead(204); res.end();
      if (p === '/log') {
        console.log(`[stage${msg.level && msg.level !== 'info' ? ` ${msg.level}` : ''}] ${msg.msg}`);
        if (msg.level === 'error') pageErrors++;
      } else if (p === '/progress') {
        const pct = Math.round((msg.frame / Math.max(1, msg.total)) * 100);
        log(`Rendering ${pct}% (${msg.frame}/${msg.total} frames, ${msg.fps} fps)`);
        if (Date.now() - lastProgressReport > 20000) {
          lastProgressReport = Date.now();
          reportStatus('running', `4/5 Rendering the video (${pct}%)`, Math.round(60 + pct * 0.25), '');
        }
      } else if (p === '/done') {
        finished?.({ ok: true, character: msg.character });
      } else if (p === '/fail') {
        finished?.({ ok: false, reason: msg.error || 'stage failed' });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'animato-chrome-'));
  const chromeArgs = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--window-size=1280,800', '--js-flags=--max-old-space-size=4096', `http://127.0.0.1:${port}/`];
  const browser = spawn(chrome, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  browser.stderr.on('data', (d: Buffer) => { chromeErr += d.toString(); if (chromeErr.length > 20000) chromeErr = chromeErr.slice(-10000); });
  browser.on('close', (code: number | null) => finished?.({ ok: false, reason: `Chrome exited (${code}): ${chromeErr.split('\n').filter((l) => /error|fatal/i.test(l)).slice(-3).join(' | ')}` }));
  log(`Rendering ${totalFrames} frames at ${W}x${H} in headless Chrome (${path.basename(chrome)})…`);

  const timeoutMs = Math.max(8, Math.ceil(opts.duration / 60) * 9) * 60 * 1000;
  const timer = setTimeout(() => finished?.({ ok: false, reason: `stage timed out after ${Math.round(timeoutMs / 60000)} min (${framesWritten}/${totalFrames} frames)` }), timeoutMs);
  const outcome = await result;
  clearTimeout(timer);
  try { browser.kill('SIGKILL'); } catch {}
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}

  if (!outcome.ok || framesWritten < totalFrames * 0.98) {
    try { ff.kill('SIGKILL'); } catch {}
    await ffDone;
    return { ok: false, character: 'none', reason: outcome.reason || `only ${framesWritten}/${totalFrames} frames rendered` };
  }
  ff.stdin.end();
  const code = await ffDone;
  if (code !== 0) return { ok: false, character: 'none', reason: `FFmpeg failed: ${ffErr.trim().split('\n').slice(-3).join(' | ')}` };
  if (pageErrors) log(`⚠️ The stage reported ${pageErrors} error(s) but finished.`);
  return { ok: true, character: outcome.character || 'unknown' };
}

/** Fallback when Chrome is unavailable: scene images + captions, no character. */
async function renderFallback(opts: { narration: Narration; times: { start: number; end: number }[]; images: (string | null)[]; title: string; badge: string; music: string | null; duration: number }) {
  const list = path.join(WORK_DIR, 'scenes.ffconcat');
  const lines = ['ffconcat version 1.0'];
  opts.images.forEach((img, i) => {
    lines.push(`file '${img}'`);
    lines.push(`duration ${Math.max(0.5, opts.times[i].end - opts.times[i].start).toFixed(3)}`);
  });
  lines.push(`file '${opts.images[opts.images.length - 1]}'`);
  fs.writeFileSync(list, lines.join('\n') + '\n');
  const ass = path.join(WORK_DIR, 'captions.ass');
  const size = Math.round(Math.min(W, H) * 0.075);
  const esc = (t: string) => t.replace(/[{}\\]/g, '');
  const ts = (t: number) => { const cs = Math.max(0, Math.round(t * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
  const groups: { s: number; e: number; t: string }[] = [];
  let cur: Word[] = [];
  const flush = () => { if (cur.length) groups.push({ s: cur[0].start, e: cur[cur.length - 1].end + 0.1, t: cur.map((w) => w.text).join(' ') }); cur = []; };
  for (const w of opts.narration.words) { cur.push(w); if (cur.length >= 3 || /[.!?,]$/.test(w.text)) flush(); }
  flush();
  fs.writeFileSync(ass, `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: C,Poppins,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${Math.round(size * 0.12)},3,5,60,60,0,1\nStyle: B,Poppins,${Math.round(size * 0.45)},&H00111111,&H00FFFFFF,&H003FD2FF,&H003FD2FF,-1,0,0,0,100,100,1,0,3,${Math.round(size * 0.25)},0,8,40,40,${Math.round(H * 0.04)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 1,${ts(0)},${ts(opts.duration)},B,,0,0,0,,${esc(opts.badge)}\n${groups.map((g) => `Dialogue: 0,${ts(g.s)},${ts(g.e)},C,,0,0,0,,${esc(g.t.toUpperCase())}`).join('\n')}\n`);
  const aud = audioArgs(opts.narration.audioPath, opts.music, 1);
  const vf = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},subtitles=filename='${ass}':fontsdir='${path.join(HERE, 'assets/fonts')}',format=yuv420p[vout]`;
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, ...aud.inputs,
    '-filter_complex', `${vf};${aud.filter}`, '-map', '[vout]', '-map', '[aout]', '-t', opts.duration.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', OUTPUT_VIDEO], { timeoutMs: 20 * 60 * 1000 });
  if (r.code !== 0) throw new PipelineError('render_failed', `FFmpeg failed: ${r.stderr.trim().split('\n').slice(-4).join(' | ')}`);
}

// ---------------------------------------------------------------------------
// 6. YouTube
// ---------------------------------------------------------------------------
let cachedYouTubeToken = '';

async function youtubeAccessToken(): Promise<string> {
  if (cachedYouTubeToken) return cachedYouTubeToken;
  if (!CFG.ytRefreshToken) throw new PipelineError('youtube_not_connected', 'No YouTube account is connected to this automation. Open its dashboard and press "Connect YouTube".');
  if (!CFG.ytClientSecret) throw new PipelineError('youtube_config', 'The YouTube OAuth client secret was not provided to the runner.');
  const res = await fetch(CFG.googleTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CFG.ytClientId, client_secret: CFG.ytClientSecret, refresh_token: CFG.ytRefreshToken, grant_type: 'refresh_token' }).toString(),
    signal: AbortSignal.timeout(30000)
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    if (data?.error === 'invalid_grant') {
      throw new PipelineError('youtube_reauth', 'YouTube access expired or was revoked. Reconnect YouTube in this automation\'s dashboard. (If your Google OAuth consent screen is still in "Testing", Google expires the connection every 7 days — set it to "In production".)');
    }
    throw new PipelineError('youtube_auth', `Google token refresh failed (HTTP ${res.status}): ${data?.error_description || data?.error || 'unknown error'}`);
  }
  cachedYouTubeToken = data.access_token;
  return cachedYouTubeToken;
}

const YT_CATEGORY: Record<string, string> = { cooking: '26', tech: '28', stories: '24', news: '25' };

async function uploadToYouTube(meta: { title: string; description: string; tags: string[]; synthetic: boolean }): Promise<{ videoId: string; url: string; privacy: string }> {
  const token = await youtubeAccessToken();
  const bytes = fs.readFileSync(OUTPUT_VIDEO);
  let title = meta.title.replace(/[<>]/g, '').trim() || 'New video';
  // No "#Shorts" in the title: YouTube classifies Shorts by length + vertical frame, and
  // the tag is already in the description's hashtag line — the title stays clean.
  title = title.slice(0, 100);
  let tagChars = 0;
  const tags = meta.tags.filter((t) => { tagChars += t.length + 3; return tagChars < 480; });
  const body = {
    snippet: { title, description: meta.description.slice(0, 4900), tags, categoryId: YT_CATEGORY[CFG.category] || '24', defaultLanguage: 'en', defaultAudioLanguage: 'en' },
    status: { privacyStatus: CFG.privacy, selfDeclaredMadeForKids: false, containsSyntheticMedia: meta.synthetic }
  };
  const init = await fetch(`${CFG.youtubeUploadBase}/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(bytes.length), 'X-Upload-Content-Type': 'video/mp4' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  if (!init.ok) {
    const text = await init.text();
    const reason = /quotaExceeded/.test(text) ? 'YouTube API daily quota reached — uploads resume after midnight Pacific time.'
      : /uploadLimitExceeded/.test(text) ? 'This YouTube channel has hit its daily upload limit.'
      : /youtubeSignupRequired/.test(text) ? 'The connected Google account has no YouTube channel yet.'
      : `YouTube rejected the upload (HTTP ${init.status}): ${text.slice(0, 300)}`;
    throw new PipelineError('youtube_upload', reason);
  }
  const location = init.headers.get('location');
  if (!location) throw new PipelineError('youtube_upload', 'YouTube did not return an upload URL.');
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const put = await fetch(location, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4' }, body: bytes, signal: AbortSignal.timeout(10 * 60 * 1000) });
      const text = await put.text();
      if (put.ok) {
        const data = JSON.parse(text || '{}');
        if (!data.id) throw new Error('upload finished without a video id');
        const url = IS_SHORTS ? `https://youtube.com/shorts/${data.id}` : `https://www.youtube.com/watch?v=${data.id}`;
        return { videoId: data.id, url, privacy: data?.status?.privacyStatus || CFG.privacy };
      }
      lastErr = `HTTP ${put.status}: ${text.slice(0, 300)}`;
      if (put.status < 500) break;
    } catch (err: any) {
      lastErr = err?.message || String(err);
    }
    await sleep(attempt * 5000);
  }
  throw new PipelineError('youtube_upload', `Video upload to YouTube failed: ${lastErr}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  console.log('='.repeat(64));
  console.log('ANIMATO CLOUD RENDERER');
  console.log(`campaign=${CFG.campaignId || '(none)'} part=${CFG.partNumber} category=${CFG.category} format=${CFG.format} ${W}x${H} gender=${CFG.gender} autoPost=${CFG.autoPost}`);
  console.log('='.repeat(64));

  let pastStory = CFG.previousScript ? `PART ${CFG.partNumber - 1}:\n${CFG.previousScript}` : '';
  let pastTitles: string[] = [];
  let pastSources: string[] = [];
  if (CFG.campaignId && CFG.appUrl) {
    const camp = await appRequest('GET', campaignPath());
    if (camp?.status === 404) { log('This automation was deleted in the app — nothing to do.'); return 0; }
    if (camp?.status === 200 && camp.data?.campaign?.status === 'paused') {
      log('This automation is paused in the app — skipping this run.');
      await reportStatus('skipped', 'Skipped (automation paused)', 0, 'Run skipped because the automation is paused.');
      return 0;
    }
    if (!camp) log('⚠️ The app is not reachable from GitHub right now — continuing without live status updates.');
    const hist = await appRequest('GET', `${campaignPath()}/history`);
    const episodes: any[] = Array.isArray(hist?.data?.storyHistory) ? hist!.data.storyHistory : [];
    pastTitles = episodes.map((e) => String(e.title || '')).filter(Boolean);
    pastSources = [
      ...episodes.flatMap((e) => (Array.isArray(e.sources) ? e.sources : [])),
      ...(Array.isArray(hist?.data?.usedHeadlines) ? hist!.data.usedHeadlines : [])
    ].map((x: any) => String(x || '')).filter(Boolean);
    if (CFG.category === 'stories' && episodes.length) {
      pastStory = episodes.filter((e) => Number(e.partNumber) < CFG.partNumber).slice(-4)
        .map((e) => `PART ${e.partNumber} — ${e.title}:\n${String(e.script || '').slice(0, 1600)}`).join('\n\n') || pastStory;
    }
  }

  await reportStatus('running', '1/5 Writing the script', 8, `GitHub runner started Part ${CFG.partNumber} (${CFG.format === 'shorts' ? 'YouTube Short' : 'YouTube video'}, ${CFG.aspect}).`);

  if (CFG.autoPost && !CFG.dryRun) {
    await youtubeAccessToken();
    log('YouTube connection verified.');
  }

  // 1. Script
  const script = await generateScript(pastStory, pastTitles, pastSources);
  if (script.usedFallbackTemplate && !CFG.allowFallbackPublish) {
    // Keys work but every free model was busy / rate-limited / filtered: retry later (no pause).
    throw new PipelineError('script_retry', `No free AI model produced a script this time (${script.aiError || 'unknown error'}). Nothing was posted; the next attempt runs automatically with the next free model/key.`);
  }
  const fullText = script.scenes.map((s) => s.narration).join(' ');
  await reportStatus('running', '2/5 Recording the voice-over', 22, `Script ready: "${script.title}" (${script.scenes.length} scenes${script.model ? `, ${script.model}` : ''}).`);

  // 2. Voice (+ start fetching images in parallel)
  const imagesPromise = gatherImages(script);
  const narration = await synthesizeNarration(fullText);
  if (!narration.neural && CFG.autoPost && !CFG.allowFallbackPublish) {
    throw new PipelineError('tts_failed', `The neural voice (Microsoft Edge TTS) failed on every voice and retry, so only a robotic fallback voice was available. Nothing was posted; the next run will retry automatically. Last error: ${LAST_TTS_ERROR.slice(0, 300) || 'unknown'}`);
  }
  const duration = +(narration.duration + (CFG.category === 'stories' ? 1.6 : 1.2)).toFixed(3);
  const times = timeScenes(script.scenes, narration.words, duration);
  const cues = timeCues(script.scenes, narration.words, times);
  log(`Performance: ${cues.length} cues (${cues.filter((c) => EMOTION_TAGS.includes(c.tag)).length} expression changes, ${cues.filter((c) => c.tag.startsWith('look')).length} looks) pinned to word timings.`);
  await reportStatus('running', '3/5 Finding an image for every scene', 38, `Voice-over recorded (${narration.duration.toFixed(0)}s, ${narration.engine}).`);

  // 3. Images, character rig, music
  const [{ files: images, aiCount }, music] = await Promise.all([imagesPromise, findMusic()]);
  const presenter = CFG.characterSpec ? `${CFG.characterSpec.name || 'custom'} (designed in the app)` : `default ${CFG.gender} presenter`;
  await reportStatus('running', '4/5 Rendering the video', 58, `${images.filter(Boolean).length} scene images ready; character: ${presenter}.`);

  // 4. Render
  const badge = CFG.category === 'stories' ? `PART ${CFG.partNumber}${CFG.subGenre ? ` · ${CFG.subGenre.toUpperCase()}` : ''}`
    : CFG.category === 'cooking' ? 'RECIPE' : CFG.category === 'tech' ? 'TECH' : CFG.category === 'news' ? 'NEWS' : CFG.category.toUpperCase();
  const endCard = CFG.category === 'stories' ? `Part ${CFG.partNumber + 1} next — follow!` : 'Follow for more';
  const title = script.title.replace(/\s*\(part \d+\)\s*$/i, '');
  const stage = await renderWithStage({ narration, scenes: script.scenes, times, cues, images, title, badge, endCard, music, duration });
  let characterMode = stage.character;
  if (!stage.ok) {
    log(`⚠️ Character renderer unavailable (${stage.reason}). Rendering scenes + captions without the character.`);
    await reportStatus('running', '4/5 Rendering (fallback)', 70, `⚠️ Character renderer failed: ${stage.reason}. Using the fallback renderer.`);
    await renderFallback({ narration, times, images: images as string[], title, badge, music, duration });
    characterMode = 'none (fallback)';
  }
  const outDur = await probeDuration(OUTPUT_VIDEO);
  if (outDur < 3) throw new PipelineError('render_failed', `Rendered video is only ${outDur.toFixed(1)}s long.`);
  log(`Video: ${(fs.statSync(OUTPUT_VIDEO).size / 1e6).toFixed(1)} MB, ${outDur.toFixed(1)}s, character: ${characterMode}.`);

  const hashtagLine = [...script.hashtags, ...(IS_SHORTS ? ['shorts'] : [])].map((h) => `#${h}`).join(' ');
  const description = [
    script.description || script.title,
    CFG.category === 'stories' ? `\nPart ${CFG.partNumber}. Part ${CFG.partNumber + 1} is coming — follow so you don't miss it.` : '',
    script.sources?.length ? `\nSources: ${script.sources.join('; ')}` : '',
    `\n${hashtagLine}`
  ].filter(Boolean).join('\n').trim();

  fs.writeFileSync(OUTPUT_META, JSON.stringify({
    campaignId: CFG.campaignId, partNumber: CFG.partNumber, format: CFG.format, aspect: CFG.aspect,
    title: script.title, description, hashtags: script.hashtags, tags: script.tags, model: script.model,
    scenes: script.scenes.map((s, i) => ({ ...s, start: times[i].start, end: times[i].end })),
    cues,
    voice: narration.engine, character: characterMode, durationSec: outDur, createdAt: new Date().toISOString()
  }, null, 2));

  // 5. Publish
  let published: { videoId: string; url: string; privacy: string } | null = null;
  if (!CFG.autoPost) {
    log('Auto-post is OFF for this automation — the video is saved as a run artifact only.');
  } else if (CFG.dryRun) {
    log('Dry run — skipping the YouTube upload.');
  } else {
    await reportStatus('running', '5/5 Uploading to YouTube', 88, `Uploading the ${IS_SHORTS ? 'Short' : 'video'} to YouTube…`);
    published = await uploadToYouTube({ title: script.title, description, tags: script.tags, synthetic: aiCount > 0 || CFG.category === 'news' });
    log(`Published: ${published.url} (privacy: ${published.privacy})`);
  }

  // 6. Report back — the app records the episode and schedules the next one.
  const episode = await appRequest('POST', `${campaignPath()}/episodes`, {
    partNumber: CFG.partNumber, title: script.title, script: fullText, description,
    youtubeUrl: published?.url || '', videoId: published?.videoId || '', published: !!published,
    privacyStatus: published?.privacy || '', format: CFG.format, aspectRatio: CFG.aspect,
    usedFallbackTemplate: script.usedFallbackTemplate, voice: narration.engine, character: characterMode,
    durationSec: Math.round(outDur), runId: CFG.runId, runUrl: CFG.runUrl,
    sources: script.sources || [], model: script.model || ''
  });
  if (CFG.campaignId && CFG.appUrl && (!episode || episode.status >= 300)) {
    console.warn(`⚠️ Could not record the episode in the app (${episode ? `HTTP ${episode.status}` : 'app unreachable'}).`);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  await reportStatus('completed', published ? 'Published to YouTube' : 'Video rendered', 100,
    published ? `✅ Part ${CFG.partNumber} published in ${secs}s: ${published.url}` : `✅ Part ${CFG.partNumber} rendered in ${secs}s (not published).`,
    { youtubeUrl: published?.url || '' });
  log(`Done in ${secs}s.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err: any) => {
    const code = err instanceof PipelineError ? err.code : 'unexpected';
    const message = err?.message || String(err);
    console.error(`❌ ${message}`);
    if (!(err instanceof PipelineError)) console.error(err?.stack || err);
    await reportStatus('failed', 'Failed', 0, `❌ ${message}`, { error: message, errorCode: code });
    if (IN_ACTIONS) console.log(`::error title=Animato render failed::${message.replace(/\r?\n/g, ' ')}`);
    process.exit(1);
  });
