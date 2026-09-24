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
import { publishToFacebook, publishToInstagram, SocialError } from './social.ts';
import { researchNews, researchRecipe, factSheet, factCheck, visionMatches, metadataMatches, identifierTokens, type FactPack, type ResearchCtx } from './research.ts';
import { composeBuffers, eqForVoice, automateLevel, levelDb, encodeWav, moodFor } from './music.ts';

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
  // Where to publish: any of youtube, facebook, instagram (older jobs: YouTube only).
  targets: new Set(String(pick(JOB.publish_targets, '')).split(',').map((x) => x.trim()).filter(Boolean)),
  fbPageId: pick(AUTH.facebook_page_id, ENV.FACEBOOK_PAGE_ID),
  fbPageToken: pick(AUTH.facebook_page_token, ENV.FACEBOOK_PAGE_TOKEN),
  igUserId: pick(AUTH.instagram_user_id, ENV.INSTAGRAM_USER_ID),
  fbGraphVersion: pick(AUTH.facebook_graph_version, ENV.FACEBOOK_GRAPH_VERSION, 'v23.0'),
  previousScript: pick(JOB.previous_script, ENV.PREVIOUS_SCRIPT),
  privacy: pick(JOB.privacy, ENV.YOUTUBE_PRIVACY, 'public'),
  ytRefreshToken: pick(AUTH.youtube_refresh_token, ENV.YOUTUBE_REFRESH_TOKEN),
  // Expected destination supplied by the campaign. Used as a final routing
  // guard immediately before upload.
  ytChannelId: pick(AUTH.youtube_channel_id, ENV.YOUTUBE_CHANNEL_ID),
  ytClientId: pick(AUTH.youtube_client_id, ENV.YOUTUBE_CLIENT_ID, DEFAULT_YT_CLIENT_ID),
  ytClientSecret: pick(AUTH.youtube_client_secret, ENV.YOUTUBE_CLIENT_SECRET),
  // Script writer keys the app sent (comma-separated) + repository secrets; rotated with instant failover.
  geminiKeys: keyList(AUTH.gemini_api_keys, AUTH.gemini_api_key, ENV.GEMINI_API_KEYS, ENV.GEMINI_API_KEY),
  groqKeys: keyList(AUTH.groq_api_keys, AUTH.groq_api_key, ENV.GROQ_API_KEYS, ENV.GROQ_API_KEY),
  geminiModels: listOf(pick(JOB.gemini_models, ENV.GEMINI_MODELS)),
  groqModels: listOf(pick(JOB.groq_models, ENV.GROQ_MODELS)),
  nvidiaKey: pick(AUTH.nvidia_api_key, ENV.NVIDIA_API_KEY),
  characterSpec: parseSpec(pick(JOB.character_spec, ENV.CHARACTER_SPEC)),
  // Story arcs: every story is told in at most 3 parts and then finished for good.
  arcParts: Math.max(1, parseInt(pick(JOB.arc_parts, '3'), 10) || 3),
  storyPremise: pick(JOB.story_premise),
  storyCharacters: pick(JOB.story_characters),
  storyTitle: pick(JOB.story_title),
  adBrief: pick(JOB.ad_brief),
  adImages: String(pick(JOB.ad_images) || '').split(',').map((x) => x.trim()).filter(Boolean),
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
  // Real-image sources (news, tech, tutorials, cooking, ads). Overridable for tests.
  wikiApiBase: pick(ENV.WIKI_API_BASE, 'https://en.wikipedia.org/w/api.php'),
  commonsApiBase: pick(ENV.COMMONS_API_BASE, 'https://commons.wikimedia.org/w/api.php'),
  openverseBase: pick(ENV.OPENVERSE_BASE, 'https://api.openverse.org/v1/images/'),
  wikidataApiBase: pick(ENV.WIKIDATA_API_BASE, 'https://www.wikidata.org/w/api.php'),
  youtubeUploadBase: pick(ENV.YOUTUBE_UPLOAD_BASE, 'https://www.googleapis.com/upload/youtube/v3'),
  newsBase: pick(ENV.NEWS_RSS_BASE, 'https://news.google.com/rss/search'),
  allowFallbackPublish: ENV.PUBLISH_WITH_FALLBACK_CONTENT === 'true',
  maxRenderSeconds: parseInt(pick(ENV.MAX_VIDEO_SECONDS, '0'), 10) || 0
};

if (IN_ACTIONS) {
  for (const secret of [CFG.fbPageToken, CFG.ytRefreshToken, CFG.ytClientSecret, ...CFG.geminiKeys, ...CFG.groqKeys, CFG.nvidiaKey, CFG.runnerKey, CFG.pollinationsKey, CFG.pexelsKey, CFG.pixabayKey]) {
    if (secret && secret.length > 6) console.log(`::add-mask::${secret}`);
  }
}

const OUTPUT_DIR = path.resolve(ENV.ANIMATO_OUTPUT_DIR || path.join(process.cwd(), 'output'));
const WORK_DIR = path.join(OUTPUT_DIR, 'work');
const OUTPUT_VIDEO = path.join(OUTPUT_DIR, 'rendered_video.mp4');
const OUTPUT_META = path.join(OUTPUT_DIR, 'video_metadata.json');
fs.mkdirSync(WORK_DIR, { recursive: true });

// Older jobs had no target list: YouTube when auto-post is on.
if (!CFG.targets.size && CFG.autoPost) CFG.targets.add('youtube');
const WANT = { youtube: CFG.targets.has('youtube'), facebook: CFG.targets.has('facebook') && !!CFG.fbPageToken, instagram: CFG.targets.has('instagram') && !!CFG.fbPageToken && !!CFG.igUserId };
const PUBLISH = WANT.youtube || WANT.facebook || WANT.instagram;

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
interface Scene { narration: string; shot: 'scene' | 'panel' | 'full'; emotion: string; imagePrompt: string; searchQuery: string; cues: Cue[]; productShot?: boolean; imageCredit?: string }

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
  premise?: string;
  /** Tech / tutorials: the product's official website (its real images and a screenshot are used). */
  officialUrl?: string;
  /** News / tech: the headline the video is about (its articles' photos are used). */
  sourceStory?: { title: string; source: string; link: string };
  /** Where every real image came from (shown on screen and in the description). */
  imageCredits?: string[];
  /** Full license attribution for every CC BY / public-domain image used. */
  imageAttributions?: string[];
  /** The researched facts this script was written from (non-story videos). */
  factPack?: FactPack;
  /** True once the independent fact check passed. */
  factChecked?: boolean;
  /** Links to the articles the story was verified with. */
  sourceLinks?: string[];
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

/** Every non-story video is written from a researched, verified fact sheet. */
const TRUTH_RULES = `
TRUTH RULES (the most important rules — viewers must be able to trust every word)
- Every factual statement (numbers, prices, specs, dates, names, places, quotes, features, outcomes, rankings, "first/only/biggest") must come from the FACT SHEET below, or be universally known stable background. Nothing else.
- Never invent or "round up" a detail to fill time. If the sheet doesn't say it, don't say it — explain why it matters, give context, or ask the viewer a question instead.
- Anything marked UNCONFIRMED may only be said as "reportedly" / "according to …", or left out.
- Don't present speculation, predictions or opinions as facts. Attribute claims to the outlet or company that made them.
- Your script is checked sentence by sentence against the sheet by an independent fact-checker; anything unsupported is cut.`;

function categoryBrief(pastStory: string, headlines: { title: string; source: string; date: string }[], pack: FactPack | null = null): string {
  const topic = CFG.topic ? `\nCreator's direction: "${CFG.topic}".` : '';
  const sub = CFG.subGenre ? `\nSub-genre: ${CFG.subGenre}.` : '';
  const sheet = pack ? `${TRUTH_RULES}\n\nFACT SHEET (researched and verified on the live web for this video)\n"""\n${factSheet(pack)}\n"""` : '';
  const news = pack?.headline
    ? `\nTHE STORY FOR THIS VIDEO (verified by ${pack.outlets.length} independent outlet(s)): "${pack.headline.title}"${pack.headline.source ? ` (${pack.headline.source})` : ''}. Build the whole video around it. Mention a source naturally once. Put this exact headline in "sourceHeadline".${sheet}`
    : headlines.length
    ? `\nFRESH HEADLINES (newest first; none of these has been covered on this channel before). Use ONLY facts stated here — do not invent numbers, prices, specs, quotes, names or dates:\n${headlines.map((h, i) => `${i + 1}. ${h.title}${h.source ? ` (${h.source}${h.date ? `, ${h.date.slice(0, 16)}` : ''})` : ''}`).join('\n')}\nPick the single most important/interesting story (prefer #1-#3, the newest) and build the whole video around it. Mention the source naturally once. Put the exact headline you used in "sourceHeadline".${TRUTH_RULES}`
    : '';
  switch (CFG.category) {
    case 'cooking':
      return `FORMAT: a narrated cooking tutorial${sub}${topic}${pack?.recipe ? `\n- THE DISH: ${pack.subject}. Teach exactly the VERIFIED RECIPE in the fact sheet (same amounts, times, temperatures and order).${sheet}` : `${TRUTH_RULES}\n- Pick ONE specific, genuinely good dish (different from the previous videos listed below) and use a standard, well-tested recipe for it with correct, food-safe times and temperatures.`}
- Scene 1 is the HOOK: a mouth-watering promise or a surprising tip, max 14 words ("The secret to crispy fried rice is day-old rice, and here's why.").
- Then: ingredients with exact amounts, then clear step-by-step instructions with times/temperatures, one pro tip, and a satisfying final plating moment.
- End with a one-line call to action (ask a question viewers will answer in the comments).
- Use shot "panel" for ingredient and step scenes (the presenter points at the photo), "scene" for the hook and the final dish.
- ONE thing per scene on screen: an ingredient scene shows that ingredient, a step scene shows that step, so the viewer is guided visually step by step.
- searchQuery (every scene): the ONE main thing visible at that moment in its plain common name, 1-3 words, as you'd type it into a photo search — an ingredient ("tomatoes", "red onions", "scotch bonnet peppers", "parboiled rice"), or the dish/step ("jollof rice", "frying plantain", "chopped tomatoes"). Never a sentence, never two ingredients.
- imagePrompt (every scene): a realistic overhead or 45-degree food photo of exactly that ingredient or step (e.g. "fresh ripe tomatoes on a wooden board, natural light"). Used only if no real photo is found.`;
    case 'tech':
      return `FORMAT: a tech / AI tool tutorial-review${sub}${topic}${news}
- Cover ONE real, newly released or trending AI tool, app, model or gadget${pack ? ' — the one in the verified story above' : headlines.length ? ' from the headlines above' : ''}.
- Scene 1 is the HOOK (max 14 words): the most useful or surprising thing it does for the viewer ("This free AI tool turns a photo into a 3D model in seconds.").
- Then, tutorial style: WHAT it is (one line) → the problem it solves / who it helps → WHERE to get it (official website, app store or platform by name — never invent a URL) → HOW to use it in 3-5 concrete steps ("Open…", "Upload…", "Type a prompt like…", "Export…") → one pro tip → one honest limitation → a clear verdict.
- Talk like a friendly expert showing a friend, not an ad. Never state a spec, price, date or feature that is not in the fact sheet.
- Teach, don't announce: the viewer should finish knowing exactly what it does for THEM, where to find it and what to click first. Say the steps out loud ("[count] Step one: open…"), and react to what impresses you.
- Use shot "panel" for most scenes: the presenter points at the image of the tool/step.
- The pictures are REAL images found on the web — the product's own website and screenshots, the news articles about it, press photos — never generated. So:
  - "officialUrl": the tool's official website or product page (e.g. "https://gemini.google.com"). Only a URL you are sure is real; otherwise leave it empty.
  - searchQuery (every scene): name the real product, company, person or device EXACTLY, with the full model name/number (e.g. "Samsung Galaxy S25 Ultra", "iPhone 16 Pro", "Nvidia Blackwell GPU", "Sam Altman"), 2-6 words, no generic words like "technology" or "AI concept". The picture must show that exact product.${pack || headlines.length ? '' : '\n- No headlines were available: pick a well-known, clearly real AI tool and stay factual.'}`;
    case 'ads': {
      const brief = CFG.adBrief
        ? `\nTHE PRODUCT (read from the advertiser's own PDF — use ONLY these facts, never invent a price, feature, claim or link):\n"""${CFG.adBrief.slice(0, 5000)}"""`
        : '\nNo product document was provided: write a clean, honest teaser for the product named in the creator\'s direction and invent nothing.';
      const adRules = CFG.adBrief ? TRUTH_RULES.replace(/the FACT SHEET below/g, 'THE PRODUCT document above').replace(/the sheet/g, 'the document') : '';
      return `FORMAT: a short, honest product advert that viewers actually enjoy${sub}${topic}${brief}${adRules}
- Scene 1 is the HOOK (max 14 words): the problem the viewer has, or the single best thing this product does ("Your meeting notes write themselves now — here's how.").
- Then: what it is in one line → who it's for → the 2-3 features that matter, each with the benefit in plain words → how to get it (the exact site, app store or plan named in the document) → the offer or price ONLY if the document states it → a clear call to action.
- The presenter genuinely likes it and speaks from experience: warm, specific, never shouty, no fake urgency, no invented testimonials.
- Use shot "panel" whenever the product is shown, and set "productShot": true on those scenes so the real product photo from the PDF is used.
- searchQuery (scenes without a product photo): the product or company name as written in the document, or the real everyday setting it is used in ("small business owner laptop"). Real photos only — nothing is generated.`;
    }
    case 'news':
      return `FORMAT: a 60-second news explainer${sub}${topic}${news}
- Scene 1 is the HOOK: what happened, in max 14 words, in plain language.
- Then: the key facts (who, what, where, when) exactly as the fact sheet states them, why it matters to the viewer, and what happens next. Neutral, accurate, no speculation, no opinions.
- It must be a story that is NOT in the list of previous video titles below.
- Use shot "panel" for fact scenes. The pictures are the REAL photos from the news articles about this story (never generated), so searchQuery must name the real place/person/organisation/event exactly as a news photo caption would (e.g. "Lagos flooding", "Bola Tinubu", "SpaceX Starship launch"), 2-6 words.
- The presenter reacts like someone who has followed the story: a beat of surprise at the number that matters, [lean_in] for the human detail, [serious] for the consequence. Viewers must feel this really happened, not that a page is being read.
- Close with what to watch for next — only what the sources say is scheduled or expected, never your own prediction.${pack || headlines.length ? '' : '\n- No headlines were available: explain one important, well-established recent development without inventing details.'}`;
    default: {
      const tone = /horror|suspense|scary/i.test(CFG.subGenre) ? 'village/small-town horror: slow dread, a real folk-evil or haunting, sensory detail (cold air, oil lamps, footsteps on sand), frightening but never gory'
        : /mystery/i.test(CFG.subGenre) ? 'a gripping mystery with clues the viewer can follow and a fair, surprising answer'
        : /twist/i.test(CFG.subGenre) ? 'a clean setup, quiet misdirection and a twist that recontextualises everything'
        : /love|romance/i.test(CFG.subGenre) ? 'warm, emotional, bittersweet and hopeful'
        : 'gripping, emotional, cinematic';
      const part = CFG.partNumber, last = CFG.arcParts;
      const known = CFG.storyPremise
        ? `\nTHIS STORY (keep every name, place and fact exactly):\n${CFG.storyPremise}${CFG.storyCharacters ? `\nCharacters: ${CFG.storyCharacters}` : ''}${CFG.storyTitle ? `\nSeries title: ${CFG.storyTitle}` : ''}`
        : '';
      const cont = pastStory ? `\nWHAT HAPPENED IN THE EARLIER PARTS:\n${pastStory}` : '';
      const arcStep = part <= 1
        ? `PART 1 of ${last} — SET UP AND IGNITE.
- Open on the protagonist by name in a specific, vivid place ("Anna sold roasted corn at the junction in Umuoka, a village where nobody walked after 9 p.m.").
- Establish what they want, the ordinary rule of their world, and the ONE thing that breaks it.
- End on the first real shock, so Part 2 is unmissable.`
        : part >= last
          ? `PART ${part} of ${last} — CLIMAX AND FULL ENDING.
- Pay off everything: the truth is revealed, the protagonist acts, the wrongdoer faces the consequence, and the reader learns what happened to everyone.
- NO cliffhanger, NO "part ${part + 1}", NO unanswered question. Close the story completely with a final line that lands (justice, a cost, a lesson, or a chilling last image).
- Finish with one line inviting the viewer to the NEXT story on the channel.`
          : `PART ${part} of ${last} — RAISE THE STAKES AND TURN.
- Deepen the danger and reveal something that changes how the viewer reads Part 1 (who is really behind it, what the protagonist did, what is at stake).
- The protagonist must DO something, fail or half-succeed, and end the part in worse trouble than they started.`;
      return `FORMAT: a complete short story told by a NARRATOR in the THIRD PERSON — a real story with a plot, not a monologue${sub}${topic}${known}${cont}
- The presenter is the storyteller and NEVER a character in it. Use names and he/she/they, never "I" for the protagonist.
- The whole story runs for EXACTLY ${last} parts and this is part ${part}.
${arcStep}
- Tone: ${tone}.
- A story means: a named protagonist with a want, a specific place (village, compound, market, boarding school, church, city flat), other named people who do things, a wrongdoing or a threat, rising consequences, and a clear ending. Things must HAPPEN — dialogue-in-narration, actions, choices, consequences — never vague musing.
- Scene 1 is the HOOK (max 16 words): one concrete, impossible-to-scroll-past fact about this story.
- Every scene moves the plot: new information, a new action or a new consequence. No repetition, no filler, no summarising what was just said.
- Short spoken sentences, past tense, plain words. Keep the viewer feeling it: sounds, smells, small physical details.
${part >= last ? '- The title must NOT contain "(Part ...)" if the story ends here; instead make it the story\'s own title.' : `- Title must end with "(Part ${part})".`}
- Also return "premise": 2-3 sentences of what this story is about, who is in it and what has happened so far (the next part is written from this), and "characters": each named person's fixed look (age, build, hair, clothes) for the pictures.
- imagePrompt: describe the exact moment of that scene as a still from a high-end 3D animated family film (big-studio feature quality) — WHO (named character as an ORIGINAL stylised cartoon character + their fixed look; never an existing movie character), WHERE (a cartoon version of the place), WHAT is happening, the light and the camera angle. Every person is a cartoon character with big expressive eyes and soft rounded features — never a real or photorealistic human.`;
    }
  }
}

function buildPrompt(pastStory: string, pastTitles: string[], headlines: any[], pack: FactPack | null = null): string {
  const L = lengthSpec();
  const avoid = pastTitles.length ? `\nPrevious video titles (do NOT repeat these topics): ${pastTitles.slice(-15).join(' | ')}` : '';
  return `You are writing a ${IS_SHORTS ? 'YouTube Short (vertical)' : 'YouTube video (16:9)'} of ${L.seconds}, narrated by an animated presenter.
${categoryBrief(pastStory, headlines, pack)}${avoid}

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
- The presenter LIVES the story: react as a person telling it to a friend — [lean_in] for a secret, [hands_up] at a shock, [laugh] at something funny, [crying] at heartbreak, [shake_head] at something wrong, [fist] at injustice. A flat, unreacting delivery is a failure.

YOUTUBE PACKAGING
- "title": max 70 characters, curiosity + the main keyword, honest (no false clickbait), Title Case.
- "description": a DETAILED, well-written description of 120-250 words in plain text (no hashtags, no markdown, no emoji spam, no "In this video we will" filler). Paragraph 1: a strong hook that names the exact subject (the real names of the people, product, place or dish). Paragraph 2-3: ${descriptionBrief()}. Last line: one specific question about THIS video that invites comments. Every statement must be true and match the script.
- "hashtags": 5-8 lowercase hashtags without "#", each about THIS video's actual subject: the specific names in it (person, product, brand, place, dish), the precise niche and the topic people search for — e.g. for a jollof rice video "jollofrice", "nigerianfood", "westafricanfood", "ricerecipe", "cookingtutorial". NEVER generic filler ("viral", "fyp", "foryou", "trending", "explore", "reels", "shorts", "love", "instagood", "follow", "like", "subscribe", "video", "new") and never a tag unrelated to the video.
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
  "officialUrl": "tech/tutorials: the official website of the product (real URL only), else empty",
  "premise": "stories only: 2-3 sentences — who this story is about, where, and everything that has happened so far",
  "scenes": [
    { "narration": "[emotion] spoken words with [gesture] tags where they land", "shot": "scene|panel|full", "emotion": "main emotion of the scene", "imagePrompt": "stories only: the animated scene to draw", "searchQuery": "real things to find a real photo of (names of people, products, places, dishes)", "productShot": false }
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
  ads: ['productreview', 'tools', 'smallbusiness', 'tech'],
  stories: ['storytime', 'scarystories', 'horrorstory', 'creepy'],
  cooking: ['recipe', 'cooking', 'easyrecipe', 'foodie'],
  tech: ['tech', 'technews', 'gadgets', 'ai'],
  news: ['news', 'breakingnews', 'worldnews', 'explained']
};

/** What the description's body must cover, per category. */
function descriptionBrief(): string {
  switch (CFG.category) {
    case 'news': return 'the key verified facts — what happened, who is involved, where and when — and why it matters to the viewer; say "reportedly" for anything not confirmed';
    case 'tech': return 'what the product/tool/update is, who makes it, what it actually does, how to get or use it (the real steps shown) and who it is for';
    case 'cooking': return 'the dish and where it comes from, the main ingredients, a short summary of the method with the key time/temperature, and the tip from the video';
    case 'ads': return 'what the product is, the real features and benefits from the brief (nothing invented), who it is for and how to get it';
    default: return 'a gripping spoiler-free teaser of the story — who it is about, where it happens and the mystery or danger they face — without revealing the ending or the twist';
  }
}

/** Hashtags nobody should ever use: generic reach-bait that says nothing about the video. */
const JUNK_HASHTAGS = new Set(('viral viralvideo viralvideos fyp fypage fypシ foryou foryoupage foryourpage trending trend trendingnow explore explorepage reels reel reelsinstagram reelitfeelit shorts short youtubeshorts shortvideo shortsvideo ytshorts tiktok tiktokviral instagood instagram insta instadaily photooftheday picoftheday love like likes likeforlike likeforlikes follow followme followforfollow follow4follow subscribe sub video videos new newvideo today daily best top amazing awesome cool fun funny wow omg lol goodvibes happy beautiful cute life lifestyle motivation inspiration content contentcreator creator facebook fb meta youtube youtuber watch share comment blowup blowthisup nofilter tbt the and for with this that you your part episode').split(' '));
const STOPWORDS = new Set('a an the and or but of to in on at for with from by as is are was were be been it its this that these those you your we our they their he she his her them i me my not no so than then there here what when where who why how all any can will just into over out up down about after before more most very also has have had do does did new video'.split(' '));

/** Hype words that make meaningless tags on their own ("#perfect", "#shocking"). */
const HYPE_WORDS = new Set('perfect best ultimate amazing incredible insane crazy shocking secret secrets truth finally really never ever always simple quick easy easiest fastest biggest huge must watch everyone nobody something anything nothing everything people thing things time times year years inside behind while could would should home made make makes making real still first last next part finale'.split(' '));
/** Words that make a tag clearly about the category even when the script never says them. */
const CATEGORY_ROOTS: Record<string, string[]> = {
  cooking: ['food', 'recipe', 'cook', 'kitchen', 'meal', 'dish', 'dinner', 'lunch', 'breakfast', 'bake', 'cuisine', 'foodie', 'snack', 'dessert'],
  tech: ['tech', 'gadget', 'software', 'app', 'phone', 'computer', 'coding', 'digital', 'tutorial', 'howto'],
  news: ['news', 'headline', 'breaking', 'update', 'report', 'explained', 'currentevents'],
  ads: ['review', 'product', 'shop', 'business', 'brand', 'deal'],
  stories: ['story', 'stories', 'tale', 'storytime', 'drama', 'romance', 'mystery']
};

const wordsOf = (t: string) => String(t || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/** Every 1-3 word run in the video's own words, joined — a hashtag must be one of these (or a known niche tag). */
function subjectVocabulary(sc: Script): Set<string> {
  const texts = [sc.title, sc.description, sc.premise || '', sc.sourceHeadline || '', sc.factPack?.subject || '', sc.factPack?.productName || '', CFG.subGenre, CFG.topic,
    ...sc.scenes.map((x) => `${x.narration} ${x.searchQuery || ''}`), ...(sc.tags || [])];
  const vocab = new Set<string>();
  for (const t of texts) {
    const w = wordsOf(t);
    for (let i = 0; i < w.length; i++) for (let n = 1; n <= 3 && i + n <= w.length; n++) {
      const run = w.slice(i, i + n);
      if (n === 1 && STOPWORDS.has(run[0])) continue;
      const j = run.join('');
      vocab.add(j);
      if (j.endsWith('s')) vocab.add(j.slice(0, -1)); else vocab.add(`${j}s`);
    }
  }
  return vocab;
}

/** Well-known niche tags that are always relevant to a category (people search them). */
const NICHE_TAGS: Record<string, string[]> = {
  stories: ['storytime', 'scarystories', 'horrorstory', 'horrorstories', 'creepypasta', 'mysterystory', 'shortstory', 'animatedstory', 'suspense', 'thriller', 'ghoststory', 'truescarystories', 'bedtimestory', 'lovestory', 'dramastory'],
  cooking: ['recipe', 'recipes', 'cooking', 'easyrecipe', 'easyrecipes', 'homecooking', 'cookingtutorial', 'foodie', 'dinnerideas', 'lunchideas', 'breakfastideas', 'mealprep', 'comfortfood', 'healthyrecipes'],
  tech: ['tech', 'technews', 'technology', 'gadgets', 'ai', 'artificialintelligence', 'techtips', 'tutorial', 'howto', 'software', 'apps', 'smartphone', 'productivity'],
  news: ['news', 'breakingnews', 'worldnews', 'newsupdate', 'currentevents', 'explained', 'headlines', 'politics', 'economy'],
  ads: ['productreview', 'smallbusiness', 'shopsmall', 'musthave', 'productdemo']
};

function cleanHashtagList(raw: any[], sc: Script): string[] {
  const vocab = subjectVocabulary(sc);
  const niche = new Set(NICHE_TAGS[CFG.category] || NICHE_TAGS.stories);
  // Words of the video itself (4+ letters) and the category's own vocabulary: a tag must contain one.
  const roots = [...vocab].filter((w) => w.length >= 4 && w.length <= 14 && !STOPWORDS.has(w) && !HYPE_WORDS.has(w));
  const catRoots = CATEGORY_ROOTS[CFG.category] || CATEGORY_ROOTS.stories;
  const scary = /horror|scary|creepy|ghost|haunt|suspense|thriller|mystery|spooky|paranormal/i.test(`${CFG.subGenre} ${CFG.topic} ${sc.title} ${sc.premise || ''}`);
  const relevant = (h: string) => vocab.has(h) || niche.has(h) || roots.some((r) => h.includes(r)) || catRoots.some((r) => h.includes(r));
  const ok = (h: string) => (h.length >= 3 || niche.has(h)) && h.length <= 28 && !/^\d+$/.test(h) && !JUNK_HASHTAGS.has(h) && !STOPWORDS.has(h) && !HYPE_WORDS.has(h)
    && relevant(h) && !(CFG.category === 'stories' && !scary && /horror|scary|creepy|ghost|haunt|creepypasta/.test(h) && !vocab.has(h));
  const out: string[] = [];
  const add = (h: string) => { if (ok(h) && !out.includes(h) && !out.some((o) => o === `${h}s` || `${o}s` === h)) out.push(h); };
  for (const h of raw.map(cleanHashtag)) add(h);
  if (out.length < 5) {
    // Derive from the video itself: the named subject first, then its key words.
    const subj = [sc.factPack?.productName, sc.factPack?.subject?.split(/[:\-–—|,(]/)[0]].filter(Boolean) as string[];
    for (const s of subj) { const w = wordsOf(s).filter((x) => !STOPWORDS.has(x)); if (w.length && w.length <= 3) add(w.join('')); }
    const titleWords = wordsOf(sc.title.replace(/\((part \d+|finale)\)/i, '')).filter((w) => w.length >= 5 && !STOPWORDS.has(w) && !HYPE_WORDS.has(w) && !/^\d+$/.test(w));
    for (const w of titleWords) if (out.length < 3) add(w);
    const defaults = CFG.category === 'stories'
      ? (scary ? ['storytime', 'scarystories', 'horrorstory', 'creepypasta'] : ['storytime', 'shortstory', 'animatedstory', 'dramastory'])
      : [...(DEFAULT_TAGS[CFG.category] || []), ...(NICHE_TAGS[CFG.category] || [])];
    for (const d of defaults) if (out.length < 5) add(d);
  }
  return out.slice(0, 8);
}

/** Plain, readable description text: no hashtags, markdown, links-as-markdown, emoji spam or JSON residue. */
function cleanDescriptionText(t: string): string {
  let d = String(t || '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 $2')
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1')
    .replace(/\*\*|__|`+|^#+\s*/gm, '')
    .replace(/^\s*(description|summary)\s*:\s*/i, '')
    .replace(/\[(\w+)\]/g, '')
    .replace(/(\p{Extended_Pictographic}️?){2,}/gu, (m) => [...m][0]);
  const lines = d.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, ' ').trim());
  d = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (/^\.{3}$|^(n\/a|none|tbd|description)$/i.test(d)) return '';
  return d;
}

const firstSentence = (t: string) => { const m = String(t).match(/^.{20,180}?[.!?](\s|$)/); return (m ? m[0] : String(t).slice(0, 160)).trim(); };

/** A readable, detailed body built from the (fact-checked) script when the writer's description is thin. */
function descriptionFromScript(sc: Script): string {
  const scenes = sc.scenes.map((x) => x.narration.trim()).filter(Boolean);
  if (CFG.category === 'stories') {
    // Only the set-up — never the ending or the twist.
    const setup = scenes.slice(0, Math.max(2, Math.ceil(scenes.length * 0.3))).join(' ');
    return [sc.premise && sc.premise.length > 60 ? sc.premise : setup.slice(0, 600)].join('\n\n');
  }
  return scenes.slice(0, 3).join(' ').slice(0, 700);
}

const COMMENT_QUESTION: Record<string, string> = {
  news: 'What do you think happens next? Tell us in the comments.',
  tech: 'Would you use this? Tell us in the comments.',
  cooking: 'Would you try this recipe? Tell us how yours turned out in the comments.',
  ads: 'Have questions about it? Ask in the comments.',
  stories: 'What would you have done? Tell us in the comments.'
};

/** Clean and complete the title, description and hashtags of a finished script. */
function polishMetadata(sc: Script): void {
  let d = cleanDescriptionText(sc.description);
  const words = d.split(/\s+/).filter(Boolean).length;
  if (words < 60) {
    const body = descriptionFromScript(sc);
    d = d ? `${d}\n\n${body}` : body;
  }
  if (!/\?\s*$/.test(d.split('\n').filter(Boolean).pop() || '')) d = `${d}\n\n${COMMENT_QUESTION[CFG.category] || COMMENT_QUESTION.stories}`;
  sc.description = d.slice(0, 2200).trim();
  sc.hashtags = cleanHashtagList(Array.isArray(sc.hashtags) ? sc.hashtags : [], sc);
  sc.tags = Array.from(new Set([...(sc.tags || []).map((t) => String(t).replace(/[<>#]/g, '').trim()).filter((t) => t && !JUNK_HASHTAGS.has(t.toLowerCase().replace(/\s+/g, ''))), ...sc.hashtags])).slice(0, 18);
}

/** The category section of the final description (only verified material). */
function descriptionDetails(sc: Script): string {
  const recipe = sc.factPack?.recipe || '';
  if (CFG.category === 'cooking' && recipe) {
    const lines = recipe.split('\n');
    const ing = lines.filter((l) => l.startsWith('- ')).slice(0, 20).map((l) => `• ${l.slice(2)}`);
    const steps = lines.filter((l) => /^\d+\.\s/.test(l)).slice(0, 12).map((l) => l.length > 170 ? `${l.slice(0, 167).trimEnd()}…` : l);
    const tip = lines.find((l) => l.startsWith('TIP: '));
    const safety = lines.find((l) => l.startsWith('SAFETY: '));
    return [ing.length ? `🛒 INGREDIENTS\n${ing.join('\n')}` : '', steps.length ? `👩‍🍳 METHOD\n${steps.join('\n')}` : '', tip ? `💡 ${tip}` : '', safety ? `⚠️ ${safety}` : ''].filter(Boolean).join('\n\n');
  }
  if (CFG.category === 'stories' || sc.usedFallbackTemplate) return '';
  // News / tech / ads: the key points exactly as narrated (the narration passed the fact check).
  const seen = new Set<string>();
  const points = sc.scenes.map((x) => firstSentence(x.narration)).filter((p) => {
    const k = p.toLowerCase().slice(0, 40);
    if (p.split(' ').length < 5 || seen.has(k) || /\b(subscribe|follow|comment|like this video)\b/i.test(p)) return false;
    seen.add(k); return true;
  }).slice(0, 6);
  const head = CFG.category === 'news' ? '📌 KEY POINTS' : CFG.category === 'tech' ? '📌 WHAT YOU WILL LEARN' : '📌 HIGHLIGHTS';
  return points.length >= 2 ? `${head}\n${points.map((p) => `• ${p}`).join('\n')}` : '';
}

/** Only a plain https homepage/product URL is kept (never a search, news aggregator or social page). */
function cleanOfficialUrl(v: any): string {
  const raw = String(v || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return '';
    if (/(^|\.)(google|bing|news\.google|youtube|youtu|facebook|twitter|x|instagram|tiktok|reddit|t)\.(com|co|be)$/i.test(u.hostname)) return '';
    return u.toString().slice(0, 300);
  } catch { return ''; }
}

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
        searchQuery: String(s?.searchQuery || '').replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80),
        productShot: s?.productShot === true || s?.product === true
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
  if (CFG.category === 'stories') {
    title = title.replace(/\s*\(part \d+\)\s*$/i, '');
    if (CFG.partNumber < CFG.arcParts) title = `${title.slice(0, 58)} (Part ${CFG.partNumber})`;
    else if (CFG.arcParts > 1) title = `${title.slice(0, 52)} (Finale)`;
  }
  const hashtags: string[] = Array.from(new Set<string>((Array.isArray(parsed.hashtags) ? parsed.hashtags : []).map(cleanHashtag).filter((h: string) => h.length >= 3 && !JUNK_HASHTAGS.has(h)))).slice(0, 10);
  const tags = Array.from(new Set([...(Array.isArray(parsed.tags) ? parsed.tags : []).map((t: any) => String(t).replace(/[<>#]/g, '').trim()).filter(Boolean), ...hashtags])).slice(0, 18);
  return {
    title: title.slice(0, 95),
    description: cleanDescriptionText(String(parsed.description || '')).slice(0, 2200),
    hashtags,
    tags,
    visualStyle: String(parsed.visualStyle || '').slice(0, 200),
    characters: String(parsed.characters || '').slice(0, 300),
    scenes,
    usedFallbackTemplate: false,
    model,
    sourceHeadline: String(parsed.sourceHeadline || '').slice(0, 300),
    premise: String(parsed.premise || '').replace(/\s+/g, ' ').slice(0, 900),
    officialUrl: cleanOfficialUrl(parsed.officialUrl)
  };
}

/** Research context shared by the fact research, the fact check and the image check. */
let RESEARCH_CTX: ResearchCtx | null = null;
const researchCtx = (pastTitles: string[] = []): ResearchCtx => (RESEARCH_CTX ||= {
  llm: LLM, log, offline: CFG.offline, category: CFG.category, subGenre: CFG.subGenre, topic: CFG.topic, pastTitles, adBrief: CFG.adBrief
});

/** Research BEFORE writing: every non-story video starts from verified facts. */
async function researchFor(pastTitles: string[], headlines: any[]): Promise<FactPack | null> {
  const ctx = researchCtx(pastTitles);
  if (CFG.category === 'news' || CFG.category === 'tech') {
    const pack = await researchNews(ctx, headlines);
    if (!pack && !CFG.offline) {
      throw new PipelineError('fact_check_failed', `None of the fresh ${CFG.category === 'tech' ? 'tech' : 'news'} stories could be confirmed by independent sources right now, so nothing was posted (no unverified story is ever published). The next attempt runs automatically.`);
    }
    return pack;
  }
  if (CFG.category === 'cooking') return researchRecipe(ctx);
  if (CFG.category === 'ads' && CFG.adBrief) return { subject: 'the advertised product', facts: [], excerpts: [{ source: 'advertiser PDF', url: '', text: CFG.adBrief.slice(0, 6000) }], outlets: ['advertiser document'], links: [], confirmed: true };
  return null;
}

/** "[serious] Heavy rain…" — the scene's narration with its performance tags put back in. */
function taggedOf(s: Scene): string {
  const toks = s.narration.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  toks.forEach((t, i) => { for (const c of s.cues) if (c.index === i) out.push(`[${c.tag}]`); out.push(t); });
  for (const c of s.cues) if (c.index >= toks.length) out.push(`[${c.tag}]`);
  return out.join(' ');
}

/**
 * The independent fact check. Wrong / unsupported sentences are corrected or
 * cut; if the script is still not clean after two rounds, nothing is published.
 */
async function verifyScript(script: Script, pack: FactPack | null): Promise<void> {
  if (CFG.category === 'stories' || CFG.offline || script.usedFallbackTemplate) return;
  const ctx = researchCtx();
  const sheet = pack ? factSheet(pack)
    : 'No external source document. Judge every claim against well-established, verifiable knowledge only; anything specific you cannot verify (numbers, dates, prices, specs, quotes, names) is a problem.';
  const L = lengthSpec();
  for (let round = 1; round <= 3; round++) {
    const res = await factCheck(ctx, sheet, script.scenes.map((sc) => ({ tagged: taggedOf(sc) })), script.title, script.description);
    if (!res) {
      if (pack?.confirmed && round > 1) { log('Fact check: no checker model answered for the re-check; the corrected script stands.'); return; }
      throw new PipelineError('fact_check_failed', 'The fact-checker could not be reached, so the script was not verified and nothing was posted. The next attempt runs automatically.');
    }
    if (res.titleFix) script.title = res.titleFix.replace(/[#"]/g, '').trim() || script.title;
    if (res.descriptionFix) script.description = res.descriptionFix.replace(/#\w+/g, '').trim() || script.description;
    if (res.ok || !res.fixes.size) { log(`Fact check (${res.model}), round ${round}: every statement is supported by the sources ✔`); script.factChecked = true; return; }
    log(`Fact check (${res.model}), round ${round}: ${res.fixes.size} scene(s) corrected — ${res.issues.slice(0, 4).join(' | ')}`);
    const drop: number[] = [];
    for (const [i, fixed] of res.fixes) {
      const t = parseTaggedNarration(fixed);
      if (!fixed || t.text.split(' ').length < 3) drop.push(i);
      else { script.scenes[i].narration = t.text; script.scenes[i].cues = t.cues; }
    }
    for (const i of drop.sort((a, b) => b - a)) script.scenes.splice(i, 1);
    if (script.scenes.length < Math.ceil(L.minScenes * 0.6)) {
      throw new PipelineError('fact_check_failed', `The fact-checker removed too much of the script (${script.scenes.length} scenes left) because it was not supported by the sources. Nothing was posted; the next attempt writes a new one.`);
    }
  }
  throw new PipelineError('fact_check_failed', 'The script still had unsupported claims after three fact-check rounds, so nothing was posted. The next attempt runs automatically.');
}

async function generateScript(pastStory: string, pastTitles: string[], pastSources: string[]): Promise<Script> {
  const headlines = (CFG.category === 'tech' || CFG.category === 'news') ? await recentHeadlines(pastTitles, pastSources) : [];
  const pack = CFG.category === 'stories' ? null : await researchFor(pastTitles, headlines);
  const prompt = buildPrompt(pastStory, pastTitles, pack?.headline ? [pack.headline] : headlines, pack);
  const system = 'You are an award-winning short-form video writer and director. Your videos open with an irresistible hook, make complete sense, stay engaging every single second and end with a reason to follow. You answer with one valid JSON object and nothing else.';
  let nearMiss: { script: Script; words: number } | null = null;
  let lastError = '';
  let factFailure: PipelineError | null = null;
  const withSources = (sc: Script) => {
    sc.factPack = pack || undefined;
    if (pack?.headline) {
      // The verified story is what the video is about; cite every outlet that confirmed it.
      sc.sourceHeadline = pack.headline.title;
      sc.sources = [`${pack.headline.title} (${pack.outlets.slice(0, 4).join(', ') || pack.headline.source})`];
      sc.sourceStory = { title: pack.headline.title, source: pack.headline.source, link: pack.links[0]?.url || pack.headline.link };
      if (!sc.officialUrl && pack.officialUrl) sc.officialUrl = cleanOfficialUrl(pack.officialUrl);
      sc.sourceLinks = pack.links.map((l) => l.url).filter(Boolean).slice(0, 4);
      return sc;
    }
    if (pack?.recipe) { sc.sources = [`Recipe checked against: ${pack.outlets.slice(0, 4).join(', ') || 'published recipes'}`]; return sc; }
    const used = headlines.find((h) => sc.sourceHeadline && sameStory(h.title, sc.sourceHeadline)) || (headlines.length ? headlines.find((h) => sc.scenes.some((x) => sameStory(h.title, x.narration))) : null);
    // Cite only what the video is really about — never a neighbouring headline.
    sc.sources = used ? [`${used.title} (${used.source})`] : sc.sourceHeadline ? [sc.sourceHeadline] : [];
    // The photos must be of the story the script is actually about: the matched
    // headline, else the headline the writer named — never an unrelated one.
    if (used) sc.sourceStory = { title: used.title, source: used.source, link: used.link };
    else if (sc.sourceHeadline) sc.sourceStory = { title: sc.sourceHeadline, source: '', link: '' };
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
      task: 'script',
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
        await verifyScript(script, pack);
        log(`Script by ${label} in ${((Date.now() - t0) / 1000).toFixed(1)}s: "${script.title}" — ${script.scenes.length} scenes, ${script.scenes.reduce((n, x) => n + x.narration.split(' ').length, 0)} words, ${script.scenes.reduce((n, x) => n + x.cues.length, 0)} performance cues.`);
        return script;
      } catch (err: any) {
        lastError = `${label}: ${err?.message}`;
        if (err instanceof PipelineError && err.code === 'fact_check_failed') {
          factFailure = err;
          if (/could not be reached/.test(err.message)) throw err;
          log(`${label}'s script failed the fact check (${err.message}) — asking the next model for a new script.`);
          continue;
        }
        log(`${label} answered but the script was unusable (${err?.message}) — asking the next model.`);
      }
    }
    if (!lastError) lastError = LLM.lastErrors.slice(-3).join(' | ') || 'no model answered';
  } else {
    lastError = 'offline test mode';
  }
  if (factFailure) throw factFailure; // never fall back to an unchecked script
  if (nearMiss) {
    log(`Using the best AI script (${nearMiss.words} words — a little shorter than asked) from ${nearMiss.script.model}.`);
    const sc = withSources(nearMiss.script);
    await verifyScript(sc, pack);
    return sc;
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
const RATE: Record<string, string> = { stories: '-3%', cooking: '+4%', tech: '+5%', news: '+5%', ads: '+4%' };

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

// ---------------------------------------------------------------------------
// Real images from the web — news, tech, tutorials, cooking, ads.
// Nothing here is generated: every picture is found on the web (the story's own
// news photos, the product's official site and a real screenshot of it,
// Wikipedia / Wikimedia, free photo libraries) and credited on screen.
// Only STORIES are illustrated by an image model (they are fiction).
// ---------------------------------------------------------------------------
interface WebImage {
  url: string;
  /** Short on-screen credit, e.g. "Photo: Jane Doe · CC BY 4.0". */
  credit: string;
  kind: 'screenshot' | 'wiki' | 'library' | 'product' | 'advertiser';
  /** Full attribution for the description (title, author, license, source page). */
  attribution?: string;
  /** What the image is of, from its source (file title, caption, tags) — used to check it matches the scene. */
  meta?: string;
}
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
/** Logos, icons, avatars, tracking pixels, placeholders — never used as a scene picture. */
const BAD_IMAGE = /(logo|favicon|sprite|icon|avatar|placeholder|default[-_]?(image|og|share|thumb)|blank\.|spacer|pixel|1x1|badge|button|banner-ad|advert|doubleclick|gravatar|emoji|\.svg(\?|$)|\.gif(\?|$)|data:image)/i;
const MIN_REAL_W = 600;

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const htmlDecode = (v: string) => v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/gi, '/').trim();
const absUrl = (u: string, base: string) => { try { return new URL(htmlDecode(u), base).toString(); } catch { return ''; } };
const plain = (html: any) => htmlDecode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * COPYRIGHT: only images whose license allows reuse in a monetised video with
 * cropping/zooming and no share-alike obligation are accepted — public domain,
 * CC0 and CC BY (credited). Share-alike, non-commercial, no-derivatives,
 * fair-use / non-free and trademarked files are refused.
 */
function reusableLicense(short: string, restrictions = '', forAds = false): string | null {
  const l = plain(short);
  if (!l) return null;
  if (/\b(sa|nc|nd)\b|share[- ]?alike|non-?commercial|no[- ]?deriv|fair use|non-?free|all rights reserved|copyrighted/i.test(l)) return null;
  if (/trademark/i.test(restrictions)) return null;
  if (forAds && /personality/i.test(restrictions)) return null; // a person's likeness never endorses a product
  if (/^(cc0|pdm|public domain|pd\b|pd-|no restrictions|no known copyright)/i.test(l)) return l.replace(/^pd-.*/i, 'Public domain');
  if (/^cc[- ]?by([- ][\d.]+)?$/i.test(l) || /^cc[- ]?by [\d.]+/i.test(l)) return l.toUpperCase().replace('CC-BY', 'CC BY');
  if (/^attribution$/i.test(l)) return 'CC BY';
  return null;
}
const shortCredit = (author: string, license: string) => {
  const who = plain(author).replace(/^(photo(graph)? by|by)\s+/i, '').slice(0, 26) || 'Unknown author';
  return /public domain|cc0|pdm/i.test(license) ? `Photo: ${who} · Public domain` : `Photo: ${who} · ${license}`;
};

async function fetchText(url: string, timeoutMs = 15000, maxBytes = 2_000_000): Promise<{ text: string; finalUrl: string } | null> {
  if (CFG.offline || !url) return null;
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return { text: buf.subarray(0, maxBytes).toString('utf8'), finalUrl: res.url || url };
  } catch { return null; }
}
async function fetchJson(url: string, headers: Record<string, string> = {}, timeoutMs = 15000): Promise<any> {
  if (CFG.offline) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'AnimatoAutoPoster/5.0 (+https://github.com; credits every image it uses)', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** The share / lead images of a page — used ONLY for the advertiser's own website. */
function pageImages(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const add = (u: string) => { const a = absUrl(u, pageUrl); if (a && /^https?:/i.test(a) && !BAD_IMAGE.test(a) && !out.includes(a)) out.push(a); };
  for (const m of html.slice(0, 400_000).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase() || '';
    const content = (tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (content && /^(og:image(:secure_url|:url)?|twitter:image(:src)?|image)$/.test(key)) add(content);
  }
  return out.slice(0, 6);
}
async function advertiserImages(url: string): Promise<WebImage[]> {
  const r = await fetchText(url);
  if (!r) return [];
  const who = hostOf(r.finalUrl) || hostOf(url);
  return pageImages(r.text, r.finalUrl).slice(0, 3).map((u) => ({ url: u, credit: `Image: ${who}`, kind: 'advertiser' as const, attribution: `Product images: ${who} (the advertiser)` }));
}

/** Wikimedia Commons files with their license, author and file page (only reusable ones are kept). */
async function commonsFiles(params: string, forAds = false): Promise<WebImage[]> {
  const d = await fetchJson(`${CFG.commonsApiBase}?action=query&format=json&origin=*&${params}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1600`);
  const pages = (Object.values(d?.query?.pages || {}) as any[]).sort((a, b) => (a.index || 0) - (b.index || 0));
  const out: WebImage[] = [];
  for (const p of pages) {
    const ii = p?.imageinfo?.[0];
    if (!ii || p.missing !== undefined || (ii.width || 0) < 800 || !/jpe?g|png|webp/i.test(ii.mime || ii.url || '')) continue;
    const md = ii.extmetadata || {};
    const lic = reusableLicense(md.LicenseShortName?.value || md.License?.value || '', md.Restrictions?.value || '', forAds);
    if (!lic) continue;
    const url = ii.thumburl || ii.url;
    if (!url || BAD_IMAGE.test(url)) continue;
    const author = plain(md.Artist?.value || md.Credit?.value || '');
    const title = plain(md.ObjectName?.value || String(p.title || '').replace(/^File:/, '').replace(/\.[a-z]+$/i, ''));
    const page = ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(p.title || ''))}`;
    const licUrl = plain(md.LicenseUrl?.value || '');
    const desc = plain(md.ImageDescription?.value || '').slice(0, 300);
    out.push({ url, credit: shortCredit(author, lic), kind: 'library', meta: `${title} ${desc} ${plain(md.Categories?.value || '').replace(/\|/g, ' ')}`,
      attribution: `"${title}" by ${author || 'unknown author'} — ${lic}${licUrl ? ` (${licUrl})` : ''} — ${page}` });
  }
  return out;
}

/** Lead image of the best-matching Wikipedia article — only when it is a freely licensed Commons file. */
async function wikiImages(query: string, forAds = false): Promise<WebImage[]> {
  if (!query) return [];
  const d = await fetchJson(`${CFG.wikiApiBase}?action=query&format=json&origin=*&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=2&prop=pageimages&piprop=name`);
  const pages = (Object.values(d?.query?.pages || {}) as any[]).sort((a, b) => (a.index || 0) - (b.index || 0)).filter((p) => p?.pageimage);
  if (!pages.length) return [];
  // Non-free files (fair-use logos, posters) live on Wikipedia itself, not on Commons → they come back "missing" and are skipped.
  // The article's title counts as the image's subject (the lead image of "iPhone 16 Pro" shows the iPhone 16 Pro).
  const out: WebImage[] = [];
  for (const p of pages) {
    for (const x of await commonsFiles(`titles=${encodeURIComponent(`File:${p.pageimage}`)}`, forAds)) out.push({ ...x, kind: 'wiki', meta: `${p.title} ${x.meta || ''}` });
  }
  return out;
}

/** Freely licensed photo libraries: Wikimedia Commons, Openverse (CC0/PDM/CC BY), Pexels, Pixabay. */
async function libraryImages(query: string, forAds = false): Promise<WebImage[]> {
  if (!query) return [];
  const q = encodeURIComponent(query);
  const out: WebImage[] = [];
  if (CFG.pexelsKey) {
    const d = await fetchJson(`https://api.pexels.com/v1/search?query=${q}&per_page=4&orientation=${orientation}`, { Authorization: CFG.pexelsKey });
    for (const p of d?.photos || []) out.push({ url: orientation === 'portrait' ? p.src?.portrait || p.src?.large2x : p.src?.large2x || p.src?.large, meta: String(p.alt || ''), credit: `Photo: ${String(p.photographer || 'Pexels').slice(0, 24)} · Pexels`, kind: 'library', attribution: `Photo by ${p.photographer || 'unknown'} on Pexels (Pexels License) — ${p.url || 'https://www.pexels.com'}` });
  }
  if (CFG.pixabayKey) {
    const d = await fetchJson(`https://pixabay.com/api/?key=${CFG.pixabayKey}&q=${q}&image_type=photo&safesearch=true&per_page=4&orientation=${orientation === 'landscape' ? 'horizontal' : 'vertical'}`);
    for (const h of d?.hits || []) out.push({ url: h.largeImageURL, meta: String(h.tags || ''), credit: `Photo: ${String(h.user || 'Pixabay').slice(0, 24)} · Pixabay`, kind: 'library', attribution: `Image by ${h.user || 'unknown'} on Pixabay (Pixabay Content License) — ${h.pageURL || 'https://pixabay.com'}` });
  }
  out.push(...await commonsFiles(`generator=search&gsrnamespace=6&gsrlimit=12&gsrsearch=${q}%20filetype:bitmap`, forAds));
  // Openverse (millions of CC0 / CC BY photos, e.g. Flickr food photography) is always asked:
  // Commons alone often has nothing for everyday ingredients and cooking steps.
  {
    const o = await fetchJson(`${CFG.openverseBase}?q=${q}&page_size=12&mature=false&license=cc0,pdm,by`);
    for (const r of o?.results || []) {
      if ((r.width || 0) < 800) continue;
      const lic = reusableLicense(`${r.license === 'by' ? 'CC BY' : String(r.license || '').toUpperCase()} ${r.license_version || ''}`.trim());
      if (!lic) continue;
      out.push({ url: r.url, meta: `${plain(r.title)} ${(Array.isArray(r.tags) ? r.tags : []).map((t: any) => t?.name || '').join(' ')}`, credit: shortCredit(r.creator || '', lic), kind: 'library', attribution: `"${plain(r.title) || 'Untitled'}" by ${plain(r.creator) || 'unknown author'} — ${lic}${r.license_url ? ` (${r.license_url})` : ''} — ${r.foreign_landing_url || r.url}` });
    }
  }
  return out.filter((x) => x.url && !BAD_IMAGE.test(x.url));
}

/**
 * Error / block pages that must NEVER end up in a video ("This site can't be
 * reached", HTTP errors, bot checks, captchas, parked domains).
 */
const BROKEN_PAGE = /this site can.?t be reached|site can.?t be reached|\berr_[a-z_]{4,}|dns_probe|server.?s ip address could not be found|took too long to respond|refused to connect|just a moment\.\.\.|checking (if the site connection is secure|your browser)|attention required|verify you are (a )?human|are you a robot|enable javascript and cookies to continue|unusual traffic from your|domain (is )?for sale|buy this domain|account (has been )?suspended|welcome to nginx|default web page|apache2 (ubuntu|debian) default page/i;
/** Only trusted in the page TITLE (or on a nearly empty page): these words also appear on healthy pages. */
const BROKEN_TITLE = /access denied|forbidden|\b(400|401|403|404|410|429|500|502|503|504)\b|not found|bad gateway|service unavailable|coming soon|under construction|parked|it works!|error|captcha/i;

/** Pixel variety of an image (0 = a flat colour). Blank / half-loaded screenshots score very low. */
async function imageVariety(file: string): Promise<number> {
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=96:60,format=gray', '-f', 'rawvideo', '-'], { timeoutMs: 20000 });
  if (r.code !== 0 || !r.stdout.length) return 0;
  const px = r.stdout;
  let mean = 0; for (const v of px) mean += v; mean /= px.length;
  let varc = 0; for (const v of px) varc += (v - mean) ** 2;
  const hist = new Set<number>(); for (const v of px) hist.add(v >> 3);
  return Math.sqrt(varc / px.length) * Math.min(1, hist.size / 8);
}

/** A page that loaded, but only shows a wall instead of the article / product. */
const WALLED_PAGE = /subscribe to (continue|read|keep reading)|sign in to (continue|read|keep reading)|log ?in to (continue|read)|create (a )?(free )?account to (continue|read)|register to continue|become a (member|subscriber) to|this (article|content|story) is (for|available to) subscribers|you have reached your (article|free) limit|enable cookies to continue|turn off your ad ?blocker|please disable your ad ?blocker/i;

interface Shot {
  finalUrl: string;
  title: string;
  /** One or two verified PNG captures of the page (top of page first). */
  files: string[];
}

/**
 * A VERIFIED screenshot of a live website, driven through the Chrome DevTools
 * protocol (not a blind `--screenshot`). A capture is only returned when every
 * one of these is true, so a wrong or broken picture can never reach a video:
 *
 *   1. the main document answered 2xx/3xx and Chrome did not show an error page
 *   2. the page is not a bot-check / parked / paywall / login wall
 *   3. it really is the page we asked for (same site, or the story's own words
 *      appear on it) — never a redirect to some unrelated homepage
 *   4. cookie, consent, newsletter and app-install overlays are dismissed
 *   5. lazy-loaded images, web fonts and late network work have finished
 *   6. the capture is retina (2×) and is not blank / flat
 *
 * Anything else returns null: the scene then uses a licensed photo instead.
 */
async function siteScreenshot(url: string, file: string, opts: { expect?: string[]; second?: string } = {}): Promise<Shot | null> {
  const chrome = findChrome();
  const WS = (globalThis as any).WebSocket;
  if (!chrome || CFG.offline || !url || !WS) return null;
  const wantHost = hostOf(url);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'animato-shot-'));
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-features=IsolateOrigins,site-per-process,TranslateUI', '--autoplay-policy=user-gesture-required',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  let ws: any = null;
  const cleanup = () => { try { ws?.close(); } catch {} try { proc.kill('SIGKILL'); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} };
  const fail = (why: string) => { log(`Screenshot of ${wantHost || url} rejected: ${why}.`); return null; };
  try {
    // 1. Connect to Chrome.
    let port = '';
    for (let i = 0; i < 100 && !port; i++) {
      const f = path.join(profile, 'DevToolsActivePort');
      if (fs.existsSync(f)) port = fs.readFileSync(f, 'utf8').split('\n')[0].trim();
      if (!port) await sleep(100);
    }
    if (!port) return fail('Chrome did not start');
    const targets: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) return fail('no browser tab');
    ws = new WS(page.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('devtools connection failed')); });
    let id = 0;
    const pending = new Map<number, (v: any) => void>();
    const listeners: ((m: any) => void)[] = [];
    ws.onmessage = (ev: any) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } else listeners.forEach((l) => l(m));
    };
    const cmd = (method: string, params: any = {}, timeoutMs = 20000) => new Promise<any>((res) => {
      const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ error: { message: `${method} timed out` } }); } }, timeoutMs);
    });
    const evaluate = async (expression: string, timeoutMs = 20000) => {
      const r = await cmd('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression }, timeoutMs);
      return r.result?.result?.value;
    };

    // 2. Navigate like a real desktop visitor and watch the main document's status.
    await cmd('Page.enable'); await cmd('Network.enable'); await cmd('Runtime.enable');
    await cmd('Network.setUserAgentOverride', { userAgent: BROWSER_UA, acceptLanguage: 'en-US,en;q=0.9' });
    // Retina metrics: text in the framed screenshot stays sharp at 1080p and 4K.
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await cmd('Emulation.setScriptExecutionDisabled', { value: false });
    let docStatus = 0, loaded = false, inflight = 0, lastActivity = Date.now();
    listeners.push((m) => {
      if (m.method === 'Network.responseReceived' && m.params?.type === 'Document' && !docStatus) docStatus = m.params.response?.status || 0;
      if (m.method === 'Page.loadEventFired') loaded = true;
      if (m.method === 'Network.requestWillBeSent') { inflight++; lastActivity = Date.now(); }
      if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); }
    });
    const nav = await cmd('Page.navigate', { url }, 30000);
    if (nav.error) return fail(nav.error.message);
    if (nav.result?.errorText) return fail(nav.result.errorText);
    for (let i = 0; i < 200 && !loaded; i++) await sleep(100);        // up to 20 s for the load event
    // Wait for the network to go quiet (lazy images, fonts, hero videos…).
    for (let i = 0; i < 120; i++) {
      if (inflight === 0 && Date.now() - lastActivity > 700) break;
      await sleep(100);
    }
    if (docStatus && (docStatus < 200 || docStatus >= 400)) return fail(`HTTP ${docStatus}`);

    // 3. Dismiss cookie / consent / newsletter / app-install overlays, then make
    //    every lazy image load by walking down the page and back to the top.
    await evaluate(`(async () => {
      const YES = /^(accept|accept all|accept all cookies|allow all|i agree|agree|got it|ok|okay|continue|understood|allow|yes, i agree|i accept|save and (accept|close)|reject all|decline|no thanks|not now|maybe later|close|dismiss|skip)$/i;
      const BAD = /cookie|consent|gdpr|onetrust|cmp|truste|privacy|banner|cc-window|qc-cmp|didomi|usercentrics|newsletter|subscribe|signup|sign-up|paywall|modal|overlay|popup|interstitial|app-?(banner|install)|promo|notification|sp_message|piano|tp-modal/i;
      const click = () => {
        const els = Array.from(document.querySelectorAll('button, a[role=button], [role=button], input[type=button], input[type=submit]')).slice(0, 400);
        for (const el of els) {
          const t = ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').trim();
          if (!t || t.length > 28 || !YES.test(t)) continue;
          const box = el.getBoundingClientRect();
          if (!box.width || !box.height) continue;
          const holder = el.closest('div,section,aside,dialog,form') || el;
          const tag = (holder.id || '') + ' ' + (typeof holder.className === 'string' ? holder.className : '');
          const fixed = ['fixed', 'sticky'].includes(getComputedStyle(holder).position);
          if (BAD.test(tag) || fixed || /cookie|consent/i.test((holder.innerText || '').slice(0, 300))) { try { el.click(); } catch (e) {} return true; }
        }
        return false;
      };
      click(); await new Promise((r) => setTimeout(r, 500)); click();
      // Anything still floating over the page and looking like an overlay: hide it.
      for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 4000)) {
        const s = getComputedStyle(el);
        if (s.position !== 'fixed' && s.position !== 'sticky') continue;
        const box = el.getBoundingClientRect();
        const tag = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' + (el.getAttribute('aria-label') || '');
        const txt = (el.innerText || '').slice(0, 400);
        const covers = box.height > innerHeight * 0.55 && box.width > innerWidth * 0.55;
        if (BAD.test(tag) || covers || /\\b(cookies?|consent|subscribe|newsletter|sign up)\\b/i.test(txt)) el.style.setProperty('display', 'none', 'important');
      }
      for (const el of Array.from(document.querySelectorAll('[class*=paywall], [id*=paywall], [class*=backdrop], [class*=overlay], .modal, dialog[open]')).slice(0, 200)) {
        el.style && el.style.setProperty('display', 'none', 'important');
      }
      document.documentElement.style.setProperty('overflow', 'auto', 'important');
      document.body.style.setProperty('overflow', 'auto', 'important');
      document.body.style.removeProperty('position');
      // Wake up lazy images: walk down a few screens, then come back.
      const h = Math.min(document.body.scrollHeight, innerHeight * 5);
      for (let y = 0; y <= h; y += Math.round(innerHeight * 0.75)) { window.scrollTo(0, y); window.dispatchEvent(new Event('scroll')); await new Promise((r) => setTimeout(r, 220)); }
      window.scrollTo(0, 0); window.dispatchEvent(new Event('scroll'));
      for (const img of Array.from(document.images)) { img.loading = 'eager'; if (img.dataset && img.dataset.src && !img.src) img.src = img.dataset.src; }
      try { await document.fonts.ready; } catch (e) {}
      for (let i = 0; i < 40; i++) {
        const shown = Array.from(document.images).filter((im) => im.getBoundingClientRect().top < innerHeight * 1.2 && im.naturalWidth === 0 && im.currentSrc);
        if (!shown.length) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 700));
      return true;
    })()`, 45000);

    // 4. Read the page that is actually on screen now and check it is the right one.
    const probe = await evaluate(`(() => {
      const text = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim();
      const imgs = Array.from(document.images).filter((i) => i.naturalWidth > 120 && i.getBoundingClientRect().top < innerHeight * 1.5).length;
      return { title: document.title || '', head: text.slice(0, 900), length: text.length, imgs, url: location.href,
        height: document.body ? document.body.scrollHeight : 0,
        errorPage: !!document.querySelector('#main-frame-error, .neterror, #sub-frame-error') };
    })()`);
    const info = probe;
    if (!info) return fail('page could not be read');
    if (info.errorPage || /^(chrome-error|about:)/.test(info.url)) return fail('browser error page');
    if (BROKEN_PAGE.test(`${info.title} ${info.head}`) || BROKEN_TITLE.test(info.title) || (info.length < 600 && BROKEN_TITLE.test(info.head)))
      return fail(`error/blocked page ("${String(info.title || info.head).slice(0, 60)}")`);
    if (WALLED_PAGE.test(info.head) || (WALLED_PAGE.test(`${info.title} ${info.head}`) && info.length < 1800))
      return fail('paywall / sign-in wall');
    if (info.length < 200 && info.imgs < 2) return fail('page is nearly empty');
    // Right page? Same site is enough; otherwise the story's own words must be on it.
    const gotHost = hostOf(info.url);
    const sameSite = !!gotHost && !!wantHost && (gotHost === wantHost || gotHost.endsWith(`.${wantHost}`) || wantHost.endsWith(`.${gotHost}`));
    const words = (opts.expect || []).join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !['this', 'that', 'with', 'from', 'what', 'when', 'your', 'about', 'after', 'into', 'their', 'says', 'will', 'more', 'than', 'have', 'been'].includes(w));
    const haystack = `${info.title} ${info.head} ${info.url}`.toLowerCase();
    const hits = Array.from(new Set(words)).filter((w) => haystack.includes(w));
    if (!sameSite && words.length && !hits.length)
      return fail(`redirected to ${gotHost || 'another site'}, which is not about this story`);
    if (!sameSite && !words.length) return fail(`redirected to ${gotHost || 'another site'}`);

    // 5. Capture, and check the picture itself. One retry if it comes out flat.
    const files: string[] = [];
    const grab = async (target: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const shot = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 30000);
        const b64 = shot.result?.data;
        if (!b64) { await sleep(1500); continue; }
        fs.writeFileSync(target, Buffer.from(b64, 'base64'));
        const variety = await imageVariety(target);
        if (variety >= 6) return true;
        try { fs.unlinkSync(target); } catch {}
        log(`Screenshot attempt ${attempt + 1} of ${gotHost} was flat (variety ${variety.toFixed(1)}) — waiting and retrying.`);
        await sleep(2500);
      }
      return false;
    };
    if (!(await grab(file))) return fail('blank / flat capture');
    files.push(file);
    // A second view further down the page, so two scenes never show the same frame.
    if (opts.second && info.height > 1400) {
      await evaluate(`(async () => {
        window.scrollTo(0, Math.min(document.body.scrollHeight - innerHeight, Math.round(innerHeight * 1.15)));
        window.dispatchEvent(new Event('scroll'));
        for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 3000)) {
          const s = getComputedStyle(el);
          if (s.position === 'fixed' || s.position === 'sticky') el.style.setProperty('display', 'none', 'important');
        }
        await new Promise((r) => setTimeout(r, 900));
        return true;
      })()`, 20000);
      if (await grab(opts.second)) {
        const a = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
        const b = crypto.createHash('md5').update(fs.readFileSync(opts.second)).digest('hex');
        if (a === b) { try { fs.unlinkSync(opts.second); } catch {} } else files.push(opts.second);
      }
    }
    log(`Screenshot of ${gotHost} verified: HTTP ${docStatus || 'ok'}, "${String(info.title).slice(0, 60)}", ${info.length} chars, ${info.imgs} image(s)${hits.length ? `, matched "${hits.slice(0, 4).join(', ')}"` : ''}, ${files.length} view(s) at 2×.`);
    return { finalUrl: info.url, title: info.title, files };
  } catch (err: any) {
    return fail(err?.message || String(err));
  } finally {
    cleanup();
  }
}

/** The product's official website as recorded on Wikidata (property P856) — used when the script's URL doesn't work. */
async function wikidataOfficialSite(name: string): Promise<string> {
  if (!name) return '';
  const d = await fetchJson(`${CFG.wikidataApiBase}?action=wbsearchentities&format=json&origin=*&language=en&type=item&limit=3&search=${encodeURIComponent(name)}`);
  const ids = (d?.search || []).map((x: any) => x.id).filter(Boolean).slice(0, 3);
  if (!ids.length) return '';
  const e = await fetchJson(`${CFG.wikidataApiBase}?action=wbgetentities&format=json&origin=*&props=claims&ids=${ids.join('|')}`);
  for (const qid of ids) {
    const claims = e?.entities?.[qid]?.claims?.P856 || [];
    const best = claims.find((c: any) => c.rank === 'preferred') || claims[0];
    const url = cleanOfficialUrl(best?.mainsnak?.datavalue?.value);
    if (url) return url;
  }
  return '';
}

/**
 * Present a website screenshot inside a browser window with the real address in
 * the bar. Viewers see it is the actual site, and the margin survives the
 * panel's slow zoom so no text is cut off.
 */
async function framedScreenshot(png: string, pageUrl: string, out: string): Promise<boolean> {
  const addr = (() => { try { const u = new URL(pageUrl); return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 60); } catch { return ''; } })();
  const txt = path.join(WORK_DIR, 'site_addr.txt');
  fs.writeFileSync(txt, addr || 'official website');
  const font = path.join(HERE, 'assets/fonts/Poppins-Bold.ttf');
  const vf = [
    'scale=1180:-2',
    'pad=1440:990:130:170:0x14161b',
    'drawbox=x=130:y=104:w=1180:h=66:color=0x2a2d35:t=fill',
    'drawbox=x=150:y=128:w=18:h=18:color=0xff5f57:t=fill', 'drawbox=x=178:y=128:w=18:h=18:color=0xfebc2e:t=fill', 'drawbox=x=206:y=128:w=18:h=18:color=0x28c840:t=fill',
    'drawbox=x=250:y=116:w=900:h=42:color=0x3a3e48:t=fill',
    `drawtext=fontfile=${font}:textfile=${txt}:fontsize=26:fontcolor=0xe8eaf0:x=272:y=123`
  ].join(',');
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-frames:v', '1', '-vf', vf, '-q:v', '3', out], { timeoutMs: 60000 });
  return r.code === 0 && fs.existsSync(out);
}

/** Download a real image, reject tiny / duplicate ones, normalise to JPEG. */
const usedImageHashes = new Set<string>();
const usedImageUrls = new Set<string>();
async function takeImage(img: WebImage, raw: string, out: string): Promise<boolean> {
  if (usedImageUrls.has(img.url)) return false;
  usedImageUrls.add(img.url);
  if (!(await download(img.url, raw, 30000, { 'User-Agent': BROWSER_UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }))) return false;
  const [w, h] = await imageSize(raw);
  if (w < MIN_REAL_W || h < 300 || w / h > 4 || h / w > 4) return false;
  const hash = crypto.createHash('md5').update(fs.readFileSync(raw)).digest('hex');
  if (usedImageHashes.has(hash)) return false;
  usedImageHashes.add(hash);
  return toJpeg(raw, out);
}

/** Scenes that talk about using the tool / its website get the real screenshot. */
const WEBSITE_WORDS = /\b(website|site|open|go to|visit|sign ?up|log ?in|download|install|app store|play store|click|tap|type|upload|paste|dashboard|interface|homepage|free plan|pricing)\b/i;
/** News: the scene that names where the story comes from gets the article's own page. */
const SOURCE_WORDS = /\b(according to|reported|reports|report|announced|confirmed|statement|published|sources?|story|article|headline|per )\b/i;

/** The fixed look of every named character who appears in this scene (keeps people consistent across images). */
function castFor(script: Script, scene: Scene): string {
  if (!script.characters) script.characters = CFG.storyCharacters;
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

/** Stories are illustrated as an animated family film — never photoreal, never real people. */
const ANIMATED_STYLE = 'high-end 3D animated feature-film still, every person is an ORIGINAL stylised 3D cartoon character with big expressive eyes and soft rounded features (not any existing movie, TV or game character, no logos, no brand mascots), cartoon environment, warm cinematic lighting, rich saturated colours, detailed painterly background, wholesome family-film render, no real people, no photographic humans, no realistic faces, no photorealism';
const PHOTO_WORDS = /\b(photo(graph(y|ic)?)?|photoreal(istic)?|realistic|real[- ]life|dslr|35 ?mm|50 ?mm|bokeh|film still|cinematic still|hyper ?real(istic)?|raw photo|8k photo|portrait photo|headshot)\b/gi;
/** Real-person words become cartoon characters (a story picture never shows a real human). */
const PERSON_WORDS: [RegExp, string][] = [
  [/\b(man|woman|men|women|person|people|lady|ladies|gentleman|pastor|priest|girl|boy|child|children|kid|kids|villager|villagers|crowd|mother|father|old man|old woman)\b/gi, 'cartoon $1']
];
function styleFor(script: Script): string {
  return CFG.category === 'stories' ? ANIMATED_STYLE : script.visualStyle || '';
}
/** For stories: strip photo wording and make every person a cartoon character. */
const animatedPrompt = (p: string) => {
  if (CFG.category !== 'stories') return p;
  let out = p.replace(PHOTO_WORDS, 'animated');
  for (const [re, to] of PERSON_WORDS) out = out.replace(re, to);
  return out.replace(/\bcartoon cartoon\b/gi, 'cartoon').replace(/\s+/g, ' ').trim();
};

/**
 * Does the downloaded picture really show what the presenter is talking about?
 * A vision model looks at it (Gemini, then Groq's vision model). null = no
 * vision model available (the metadata check alone decides).
 */
let visionBudget = 40;
async function looksRight(file: string, subject: string): Promise<boolean | null> {
  if (visionBudget <= 0 || CFG.offline || !LLM.hasKeys || !subject) return null;
  visionBudget--;
  const small = `${file}.vis.jpg`;
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', 'scale=512:-2', '-q:v', '5', small], { timeoutMs: 20000 });
  if (r.code !== 0 || !fs.existsSync(small)) return null;
  const v = await visionMatches(researchCtx(), fs.readFileSync(small).toString('base64'), subject, CFG.category);
  try { fs.unlinkSync(small); } catch {}
  if (!v) { visionBudget = 0; log('Image check: no vision model answered — relying on the images\' own titles/tags from now on.'); return null; }
  if (!v.match) log(`Image check: rejected a picture for "${subject}" (it shows ${v.shows || 'something else'}).`);
  return v.match;
}

/** Realistic food photo when no real photo of that ingredient / step exists (cooking only). */
async function foodImage(s: Scene, subject: string, seed: number, raw: string, out: string): Promise<boolean> {
  const what = (s.imagePrompt && !/\b(person|people|man|woman|chef|hand|hands|face)\b/i.test(s.imagePrompt) ? s.imagePrompt : `${subject}, fresh, on a kitchen counter`).slice(0, 300);
  const prompt = `${what}. Realistic professional food photography of ${subject}, appetizing, natural window light, shallow depth of field, sharp focus, true-to-life colours, no people, no hands, no text, no labels, no logos, no watermark`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const got = await aiImage(prompt, seed + attempt * 101, raw);
    if (!got || !(await toJpeg(raw, out, got === 'ai' ? 0.04 : 0))) continue;
    if ((await looksRight(out, subject)) === false) continue;
    return true;
  }
  return false;
}

async function gatherImages(script: Script): Promise<{ files: (string | null)[]; aiCount: number; credits: (string | null)[] }> {
  const isStory = CFG.category === 'stories';
  const n = script.scenes.length;
  const files: (string | null)[] = new Array(n).fill(null);
  const credits: (string | null)[] = new Array(n).fill(null);
  let aiCount = 0;

  // Test hook (never set in production): take scene images from a local folder.
  const testDir = ENV.ANIMATO_TEST_IMAGES_DIR;
  const testImages = testDir && fs.existsSync(testDir) ? fs.readdirSync(testDir).filter((x) => /\.(jpe?g|png|webp)$/i.test(x)).sort() : [];
  if (testImages.length) {
    for (let i = 0; i < n; i++) { const out = path.join(WORK_DIR, `scene_${i}.jpg`); if (await toJpeg(path.join(testDir!, testImages[i % testImages.length]), out)) files[i] = out; }
    return { files, aiCount, credits };
  }

  if (isStory) {
    // ---- STORIES: fiction, so every picture is drawn — original 3D animated cartoon scenes only.
    const style = ANIMATED_STYLE;
    const seedBase = parseInt(crypto.createHash('md5').update(`${CFG.campaignId}:${CFG.partNumber}`).digest('hex').slice(0, 6), 16);
    const deadline = Date.now() + (CFG.pollinationsKey || CFG.nvidiaKey ? 7 : 9) * 60 * 1000;
    const drawOne = async (i: number) => {
      if (Date.now() > deadline) return;
      const s = script.scenes[i];
      const raw = path.join(WORK_DIR, `scene_${i}.raw`), out = path.join(WORK_DIR, `scene_${i}.jpg`);
      const prompt = [animatedPrompt(s.imagePrompt || s.narration), animatedPrompt(castFor(script, s)), `The moment: ${animatedPrompt(s.narration.slice(0, 220))}`, style, 'no text, no watermark, no captions'].filter(Boolean).join('. ');
      const got = await aiImage(prompt, seedBase + i * 7, raw);
      if (got && await toJpeg(raw, out, got === 'ai' ? 0.04 : 0)) { files[i] = out; aiCount++; }
    };
    if (CFG.pollinationsKey || CFG.nvidiaKey) {
      const queue = script.scenes.map((_, i) => i);
      await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await drawOne(queue.shift()!); }));
    } else {
      for (let i = 0; i < n; i++) await drawOne(i); // anonymous AI is rate-limited: early scenes first
    }
  } else {
    // ---- EVERYTHING ELSE: real images found on the web. Nothing is generated.
    const deadline = Date.now() + 5 * 60 * 1000;
    const cat = CFG.category;
    const subject = (script.sourceStory?.title || script.sourceHeadline || script.title).replace(/\s*\(part \d+\)\s*$/i, '').slice(0, 160);

    // Ads: the advertiser's own product photos (imported from their PDF).
    const productFiles: string[] = [];
    if (cat === 'ads' && CFG.adImages.length && CFG.appUrl && !CFG.offline) {
      let k = 0;
      for (const id of CFG.adImages.slice(0, 8)) {
        const raw = path.join(WORK_DIR, `product_${k}.raw`), out = path.join(WORK_DIR, `product_${k}.jpg`);
        if (await download(`${CFG.appUrl}/api/automation/assets/${encodeURIComponent(id)}`, raw, 45000) && await toJpeg(raw, out)) { productFiles.push(out); k++; }
      }
      log(`Ad: ${productFiles.length}/${CFG.adImages.length} product images downloaded from the PDF.`);
    }
    let productCursor = 0;

    // COPYRIGHT-SAFE SOURCES ONLY. News/publisher photos and brands' marketing images
    // are never used: only public-domain, CC0 and CC BY images (credited), the
    // advertiser's own images (ads), and a screenshot of the tool's own interface
    // on tutorial steps (showing how to use it — review / instruction use).
    const forAds = cat === 'ads';
    const pool: WebImage[] = [];
    const briefUrl = forAds ? cleanOfficialUrl((CFG.adBrief.match(/\bhttps?:\/\/[^\s)"'<>]+|\bwww\.[a-z0-9-]+\.[a-z.]{2,}[^\s)"'<>]*/i) || [])[0]) : '';
    const official = script.officialUrl || briefUrl;
    /** News / tech: the page the story itself was published on. */
    const storyLink = cleanOfficialUrl(script.sourceStory?.link || '');
    // ---- REAL SCREENSHOTS (everything except stories)
    // News: the article's own page on the publisher's site. Tech / tutorials /
    // ads: the product's official site. Every capture is verified live — right
    // site, no cookie wall, no paywall, no error page, nothing blank — and shown
    // in a browser window with the real address, so what viewers see is exactly
    // what the site shows. If nothing passes, no screenshot is used at all.
    const shots: { file: string; credit: string; uses: number }[] = [];
    let shotUses = 0;
    const shotCap = cat === 'news' ? 2 : 3;
    if (official || storyLink || cat === 'tech') {
      const imgsP = forAds && official ? advertiserImages(official) : Promise.resolve([] as WebImage[]); // other brands' images are not used
      // Candidates, best first: the story's own article page, the URL the script
      // named, those sites' front pages, then the product's official site on
      // Wikidata. A candidate is only used if it passes every check in
      // siteScreenshot() — the first one that does wins.
      const tried = new Set<string>();
      const names = Array.from(new Set(script.scenes.map((x) => x.searchQuery).filter(Boolean))).slice(0, 2);
      const homeOf = (u: string) => { try { const x = new URL(u); return x.pathname === '/' ? '' : `${x.origin}/`; } catch { return ''; } };
      const expect = [script.sourceStory?.title || '', script.sourceHeadline || '', subject, ...names].filter(Boolean);
      const candidates: (() => Promise<string>)[] = [
        async () => storyLink,
        async () => official,
        async () => homeOf(storyLink),
        async () => homeOf(official),
        ...names.map((nm) => async () => wikidataOfficialSite(nm))
      ];
      const pngA = path.join(WORK_DIR, 'site_shot.png'), pngB = path.join(WORK_DIR, 'site_shot_b.png');
      let shot: Shot | null = null;
      const started = Date.now();
      for (const next of candidates) {
        if (Date.now() - started > 150_000) break;
        const url = await next();
        if (!url || tried.has(url)) continue;
        tried.add(url);
        shot = await siteScreenshot(url, pngA, { expect, second: pngB });
        if (shot) break;
      }
      const imgs = await imgsP;
      pool.push(...imgs);
      if (shot) {
        let k = 0;
        for (const png of shot.files) {
          const jpg = path.join(WORK_DIR, `site_shot_${k}.jpg`);
          // Always presented as a framed browser window with the real address.
          if ((await framedScreenshot(png, shot.finalUrl, jpg)) || (await toJpeg(png, jpg))) {
            shots.push({ file: jpg, credit: `Screenshot: ${hostOf(shot.finalUrl)}`, uses: 0 });
          }
          k++;
        }
        // Cite the page that actually loaded (tech / tutorials / ads only — a news
        // video cites its source story separately).
        if (cat !== 'news' && (!script.officialUrl || hostOf(script.officialUrl) !== hostOf(shot.finalUrl))) script.officialUrl = shot.finalUrl;
      }
      log(shots.length
        ? `Screenshots: ${shots.length} verified live view(s) of ${hostOf(shot!.finalUrl)}${cat === 'news' ? ' (the story\u2019s own page)' : ''}.`
        : `Screenshots: none — ${tried.size ? `${tried.size} candidate(s) failed verification (${Array.from(tried).map(hostOf).join(', ')})` : 'no page to shoot'}; licensed photos are used instead.`);
    }
    /** The least-used verified screenshot that is still within its budget. */
    const nextShot = () => {
      if (shotUses >= shotCap) return null;
      const free = shots.filter((x) => x.uses < 2).sort((a, b) => a.uses - b.uses);
      return free[0] || null;
    };

    /**
     * The first image that really shows `subject`:
     *   1. its own title / caption / tags name it — for a specific product every
     *      model identifier must be there ("Galaxy S25 Ultra" ≠ "Galaxy S23"), and
     *   2. a vision model looking at it agrees.
     */
    const tryList = async (list: WebImage[], raw: string, out: string, subject: string): Promise<WebImage | null> => {
      const strict = identifierTokens(subject).length > 0;
      let checked = 0;
      for (const img of list) {
        if (Date.now() > deadline || checked >= 5) return null;
        const needsCheck = img.kind === 'library' || img.kind === 'wiki';
        if (needsCheck && subject && !metadataMatches(subject, img.meta || '', strict)) continue;
        if (!(await takeImage(img, raw, out))) continue;
        checked++;
        if (needsCheck && (await looksRight(out, subject)) === false) continue;
        return img;
      }
      return null;
    };
    const fromPool = () => pool.filter((x) => !usedImageUrls.has(x.url));
    const attributions: string[] = [];
    let generatedFood = 0;

    const fetchOne = async (i: number) => {
      const s = script.scenes[i];
      const raw = path.join(WORK_DIR, `scene_${i}.raw`), out = path.join(WORK_DIR, `scene_${i}.jpg`);
      const set = (file: string, credit: string) => { files[i] = file; credits[i] = credit; };
      if (productFiles.length && (s.productShot || (forAds && s.shot === 'panel'))) { set(productFiles[productCursor++ % productFiles.length], 'Product image'); return; }
      // A website screenshot is always shown as a framed screen (panel), never stretched full-screen.
      if (WEBSITE_WORDS.test(s.narration) || (cat === 'news' && SOURCE_WORDS.test(s.narration))) {
        const sh = nextShot();
        if (sh) { sh.uses++; shotUses++; s.shot = 'panel'; set(sh.file, sh.credit); return; }
      }
      const q = s.searchQuery || subject.split(/\s+/).slice(0, 6).join(' ');
      // Best first: the named person / place / organisation's free Wikipedia image,
      // then freely licensed photo libraries for the scene, then for the whole topic.
      const sources: (() => Promise<WebImage[]>)[] = [];
      if (forAds) sources.push(async () => fromPool());
      sources.push(async () => wikiImages(q, forAds));
      sources.push(async () => libraryImages(q, forAds));
      if (q !== subject) sources.push(async () => wikiImages(subject.split(/\s+/).slice(0, 6).join(' '), forAds));
      if (q !== subject) sources.push(async () => libraryImages(subject.split(/\s+/).slice(0, 5).join(' '), forAds));
      for (const [k, src] of sources.entries()) {
        if (Date.now() > deadline) break;
        // Scene-level sources must show the scene's subject; topic-level ones the topic.
        const subj = k < (forAds ? 3 : 2) ? q : (script.factPack?.productName || subject.split(/\s+/).slice(0, 6).join(' '));
        const got = await tryList(await src(), raw, out, cat === 'ads' && k === 0 ? '' : subj);
        if (got) { set(out, got.credit); if (got.attribution && !attributions.includes(got.attribution)) attributions.push(got.attribution); return; }
        // Cooking: a picture of something else never beats a picture of THIS ingredient/step.
        if (cat === 'cooking' && k >= 1) break;
      }
      // Cooking: no real photo of this ingredient / step → a realistic food photo of exactly it.
      if (cat === 'cooking' && Date.now() < deadline + 90_000) {
        if (await foodImage(s, q, 9000 + i * 13, raw, out)) { set(out, 'AI-generated image'); generatedFood++; return; }
      }
      // Tech: the product's own verified website shows the exact product — better than a wrong one.
      const sh = nextShot() || (cat === 'tech' ? shots.sort((a, b) => a.uses - b.uses)[0] || null : null);
      if (sh) { sh.uses++; shotUses++; s.shot = 'panel'; set(sh.file, sh.credit); }
    };
    const queue = script.scenes.map((_, i) => i);
    await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await fetchOne(queue.shift()!); }));
    // Leftover product photos still beat a repeated image for ads.
    for (let i = 0; i < n && productFiles.length; i++) if (!files[i]) { files[i] = productFiles[productCursor++ % productFiles.length]; credits[i] = 'Product image'; }
    script.imageAttributions = attributions;
    aiCount += generatedFood;
    if (generatedFood) log(`Cooking: ${generatedFood} ingredient/step picture(s) had no real photo and were generated as realistic food photos.`);
  }

  // Scenes without an image reuse the nearest one so nothing is ever blank (never an invented picture).
  for (let i = 0; i < n; i++) {
    if (files[i]) continue;
    for (let d = 1; d < n; d++) {
      const j = files[i - d] ? i - d : files[i + d] ? i + d : -1;
      if (j >= 0) { files[i] = files[j]; credits[i] = credits[j]; break; }
    }
  }
  if (!files.some(Boolean)) {
    const grad = path.join(WORK_DIR, 'gradient.png');
    const colors = CFG.category === 'cooking' ? ['0x3b1d0f', '0x9a4a12'] : CFG.category === 'tech' ? ['0x061a2b', '0x0f4c75'] : ['0x0b0b1a', '0x3a1c4a'];
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=${colors[0]}:c1=${colors[1]}:x0=0:y0=0:x1=${W}:y1=${H}:nb_colors=2`, '-frames:v', '1', grad]);
    files.fill(grad);
  }
  script.imageCredits = Array.from(new Set(credits.filter((c): c is string => !!c && c !== 'Product image')));
  if (isStory) log(`Images: ${files.filter(Boolean).length}/${n} scenes, ${aiCount} drawn as original 3D animated scenes${nvidiaCount ? `, ${nvidiaCount} by NVIDIA FLUX` : ''}${nvidiaDisabled ? `; NVIDIA unavailable: ${nvidiaDisabled}` : ''}.`);
  else log(`Images: ${new Set(files.filter(Boolean)).size} real image(s) for ${n} scenes — none generated. Sources: ${script.imageCredits.join(', ') || 'none found'}.`);
  return { files, aiCount, credits };
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

/**
 * Where the presenter is actually speaking, and how loud, measured from the
 * narration audio itself (50 ms windows) — works even when word timings are estimates.
 */
async function analyseVoice(file: string): Promise<{ levelDb: number; speech: { start: number; end: number }[] } | null> {
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { timeoutMs: 60000 });
  if (r.code !== 0 || r.stdout.length < 32000) return null;
  const pcm = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 2));
  const WIN = 800, sec = WIN / 16000;
  const dbs: number[] = [];
  for (let i = 0; i + WIN <= pcm.length; i += WIN) {
    let sum = 0;
    for (let k = i; k < i + WIN; k++) sum += (pcm[k] / 32768) ** 2;
    dbs.push(10 * Math.log10(sum / WIN + 1e-12));
  }
  const peak = Math.max(...dbs);
  const gate = Math.max(-45, peak - 32);
  let power = 0, count = 0;
  const speech: { start: number; end: number }[] = [];
  dbs.forEach((d, i) => {
    if (d <= gate) return;
    power += 10 ** (d / 10); count++;
    const t = i * sec, last = speech[speech.length - 1];
    if (last && t - last.end < 0.6) last.end = t + sec;          // short gaps are part of the phrase
    else speech.push({ start: t, end: t + sec });
  });
  if (!count) return null;
  return { levelDb: 10 * Math.log10(power / count), speech: speech.filter((x) => x.end - x.start >= 0.12) };
}

/** Integrated loudness (LUFS, EBU R128 — how loud it SOUNDS, bass weighted down) of an audio file. */
async function loudnessLufs(file: string): Promise<number | null> {
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { timeoutMs: 60000 });
  const m = r.stderr.match(/Integrated loudness:[\s\S]*?I:\s*(-?[\d.]+)\s*LUFS/);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > -70 ? v : null;
}

/**
 * Background music is ORIGINAL — composed and synthesised for this video (see
 * music.ts). No third-party track is ever used, so there is nothing to license,
 * credit or get a Content ID claim for.
 *
 * It is mixed to be clearly HEARD but never fight the voice:
 *   - EQ for phone speakers (no sub-bass) with a dip where speech lives;
 *   - 13 dB under the measured voice level while the presenter speaks (the
 *     usual broadcast "music bed" level), 7 dB under in pauses, intro and outro;
 *   - smooth swells from the real speech timing instead of a pumping compressor.
 */
const MUSIC_UNDER_VOICE_DB = 13;
const MUSIC_PAUSE_LIFT_DB = 6;
async function findMusic(seconds: number, narration: Narration): Promise<string | null> {
  try {
    const mood = moodFor(CFG.category, CFG.subGenre);
    const file = path.join(WORK_DIR, `music_${mood}.wav`);
    const t0 = Date.now();
    const { L, R, sampleRate } = composeBuffers(mood, Math.max(10, seconds), `${CFG.campaignId}:${CFG.partNumber}`);
    eqForVoice(L, R, sampleRate);
    const voice = await analyseVoice(narration.audioPath);
    const speech = voice?.speech?.length ? voice.speech : narration.words.map((w) => ({ start: w.start, end: w.end }));
    // Match PERCEIVED loudness (LUFS): a bass-heavy bed measures loud but sounds quiet,
    // so raw RMS would leave it inaudible on phones. RMS is only the fallback.
    fs.writeFileSync(file, encodeWav(L, R, sampleRate));
    const [voiceLufs, musicLufs] = await Promise.all([loudnessLufs(narration.audioPath), loudnessLufs(file)]);
    const perceived = voiceLufs !== null && musicLufs !== null;
    const voiceDb = perceived ? voiceLufs! : voice?.levelDb ?? -18;
    const musicDb = perceived ? musicLufs! : levelDb(L, R);
    const speechGain = 10 ** ((voiceDb - MUSIC_UNDER_VOICE_DB - musicDb) / 20);
    automateLevel(L, R, sampleRate, { speech, speechGain, pauseGain: speechGain * 10 ** (MUSIC_PAUSE_LIFT_DB / 20) });
    fs.writeFileSync(file, encodeWav(L, R, sampleRate));
    log(`Music: original ${mood} soundtrack composed for this video (${Math.round(seconds)}s) — ${MUSIC_UNDER_VOICE_DB} dB under the voice (${voiceDb.toFixed(1)} ${perceived ? 'LUFS' : 'dBFS'}) while speaking, +${MUSIC_PAUSE_LIFT_DB} dB between ${speech.length} spoken phrase(s), intro and outro; ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
    return file;
  } catch (err: any) {
    log(`⚠️ Music could not be composed (${err?.message || err}) — the video has voice only.`);
    return null;
  }
}

/** Audio: narration + the music bed (already levelled under the voice). */
function audioArgs(narration: string, music: string | null, firstInput: number): { inputs: string[]; filter: string } {
  const inputs = ['-i', narration];
  if (music) inputs.push('-stream_loop', '-1', '-i', music);
  const v = firstInput, m = firstInput + 1;
  const filter = music
    // The music file is already levelled and shaped around the voice (findMusic), so it is mixed as-is.
    ? `[${v}:a]aresample=48000,apad[vo];[${m}:a]aresample=48000[mus];[vo][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`
    : `[${v}:a]aresample=48000,apad[aout]`;
  return { inputs, filter };
}

async function renderWithStage(opts: {
  narration: Narration; scenes: Scene[]; times: { start: number; end: number }[]; cues: { t: number; tag: string }[]; images: (string | null)[];
  title: string; badge: string; endCard: string; music: string | null; duration: number; credits?: (string | null)[];
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
    segments: opts.scenes.map((s, i) => ({ start: opts.times[i].start, end: opts.times[i].end, text: s.narration, image: opts.images[i] ? `/img/${path.basename(opts.images[i]!)}` : null, shot: s.shot, emotion: s.emotion, credit: opts.credits?.[i] || null })),
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
let verifiedYouTubeChannelId = '';

async function youtubeAccessToken(): Promise<string> {
  if (cachedYouTubeToken && (!CFG.ytChannelId || verifiedYouTubeChannelId === CFG.ytChannelId)) return cachedYouTubeToken;
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

  // Final destination guard: resolve the YouTube channel for this OAuth
  // credential and refuse to upload if it is not the channel assigned to this
  // automation. A routing mistake therefore becomes a failed run, never a
  // cross-post to another automation.
  if (CFG.ytChannelId) {
    const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true', {
      headers: { Authorization: `Bearer ${cachedYouTubeToken}` },
      signal: AbortSignal.timeout(30000)
    });
    const chData: any = await ch.json().catch(() => ({}));
    const actualId = String(chData?.items?.[0]?.id || '');
    const actualTitle = String(chData?.items?.[0]?.snippet?.title || '');
    if (!ch.ok || !actualId) {
      throw new PipelineError('youtube_routing', `Could not verify the YouTube destination for automation ${CFG.campaignId || '(unknown)'}.`);
    }
    if (actualId !== CFG.ytChannelId) {
      throw new PipelineError(
        'youtube_routing',
        `YouTube destination mismatch for automation ${CFG.campaignId || '(unknown)'}: this automation is assigned to channel ${CFG.ytChannelId}, but the OAuth credential resolves to ${actualId}${actualTitle ? ` (${actualTitle})` : ''}. Nothing was uploaded.`
      );
    }
    verifiedYouTubeChannelId = actualId;
    log(`YouTube destination verified: ${actualTitle || actualId} (${actualId}).`);
  }

  return cachedYouTubeToken;
}

const YT_CATEGORY: Record<string, string> = { cooking: '26', tech: '28', stories: '24', news: '25', ads: '22' };

/** Build a YouTube-safe description. YouTube's limit is 5,000 UTF-8 bytes,
 * not 5,000 JavaScript characters. Strip controls and invalid URL-like text,
 * normalize whitespace, and leave headroom so emoji/non-ASCII text cannot
 * accidentally cross the API limit.
 */
function sanitizeYouTubeDescription(input: unknown): string {
  let text = String(input || '')
    .normalize('NFC')
    .replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]/g, '')
    .replace(/[<>]/g, '')
    .replace(/[ \\t]+\\n/g, '\\n')
    .replace(/\\n{4,}/g, '\\n\\n\\n')
    .trim();
  if (!text) text = 'Created automatically with Animato AutoPoster Studio.';
  while (Buffer.byteLength(text, 'utf8') > 4900) {
    text = text.slice(0, Math.max(0, text.length - 64)).trimEnd();
  }
  return text;
}

function youtubeHashtagLine(values: unknown[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const h = String(value || '').trim().replace(/^#+/, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
    if (h.length >= 3 && !seen.has(h)) {
      seen.add(h);
      out.push(`#${h}`);
    }
    if (out.length >= 9) break;
  }
  return out.join(' ');
}

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
    snippet: { title, description: sanitizeYouTubeDescription(meta.description), tags, categoryId: YT_CATEGORY[CFG.category] || '24', defaultLanguage: 'en', defaultAudioLanguage: 'en' },
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
  console.log(`campaign=${CFG.campaignId || '(none)'} part=${CFG.partNumber}/${CFG.arcParts} category=${CFG.category} format=${CFG.format} ${W}x${H} gender=${CFG.gender} autoPost=${CFG.autoPost}`);
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

  if (WANT.youtube && !CFG.dryRun) {
    await youtubeAccessToken();
    log('YouTube connection verified.');
  }
  if ((CFG.targets.has('facebook') || CFG.targets.has('instagram')) && !CFG.fbPageToken) {
    throw new PipelineError('facebook_not_connected', 'Facebook/Instagram posting is on, but no Facebook Page is connected to this automation.');
  }

  // 1. Script
  const script = await generateScript(pastStory, pastTitles, pastSources);
  polishMetadata(script);
  log(`Metadata: ${script.description.split(/\s+/).length}-word description, hashtags: ${script.hashtags.map((h) => `#${h}`).join(' ')}`);
  if (script.usedFallbackTemplate && !CFG.allowFallbackPublish) {
    // Keys work but every free model was busy / rate-limited / filtered: retry later (no pause).
    throw new PipelineError('script_retry', `No free AI model produced a script this time (${script.aiError || 'unknown error'}). Nothing was posted; the next attempt runs automatically with the next free model/key.`);
  }
  const fullText = script.scenes.map((s) => s.narration).join(' ');
  await reportStatus('running', '2/5 Recording the voice-over', 22, `Script ready: "${script.title}" (${script.scenes.length} scenes${script.model ? `, ${script.model}` : ''}).`);

  // 2. Voice (+ start fetching images in parallel)
  const imagesPromise = gatherImages(script);
  const narration = await synthesizeNarration(fullText);
  if (!narration.neural && PUBLISH && !CFG.allowFallbackPublish) {
    throw new PipelineError('tts_failed', `The neural voice (Microsoft Edge TTS) failed on every voice and retry, so only a robotic fallback voice was available. Nothing was posted; the next run will retry automatically. Last error: ${LAST_TTS_ERROR.slice(0, 300) || 'unknown'}`);
  }
  const duration = +(narration.duration + (CFG.category === 'stories' ? 1.6 : 1.2)).toFixed(3);
  const times = timeScenes(script.scenes, narration.words, duration);
  const cues = timeCues(script.scenes, narration.words, times);
  log(`Performance: ${cues.length} cues (${cues.filter((c) => EMOTION_TAGS.includes(c.tag)).length} expression changes, ${cues.filter((c) => c.tag.startsWith('look')).length} looks) pinned to word timings.`);
  await reportStatus('running', '3/5 Finding an image for every scene', 38, `Voice-over recorded (${narration.duration.toFixed(0)}s, ${narration.engine}).`);

  // 3. Images, character rig, music
  const [{ files: images, aiCount, credits }, music] = await Promise.all([imagesPromise, findMusic(duration, narration)]);
  const presenter = CFG.characterSpec ? `${CFG.characterSpec.name || 'custom'} (designed in the app)` : `default ${CFG.gender} presenter`;
  await reportStatus('running', '4/5 Rendering the video', 58, `${images.filter(Boolean).length} scene images ready; character: ${presenter}.`);

  // 4. Render
  const badge = CFG.category === 'ads' ? 'SPONSORED' : CFG.category === 'stories' ? `${CFG.partNumber >= CFG.arcParts ? 'FINALE' : `PART ${CFG.partNumber}`}${CFG.subGenre ? ` · ${CFG.subGenre.toUpperCase()}` : ''}`
    : CFG.category === 'cooking' ? 'RECIPE' : CFG.category === 'tech' ? 'TECH' : CFG.category === 'news' ? 'NEWS' : CFG.category.toUpperCase();
  const endCard = CFG.category === 'stories'
    ? (CFG.partNumber >= CFG.arcParts ? 'New story next — follow!' : `Part ${CFG.partNumber + 1} next — follow!`)
    : 'Follow for more';
  const title = script.title.replace(/\s*\(part \d+\)\s*$/i, '');
  const stage = await renderWithStage({ narration, scenes: script.scenes, times, cues, images, title, badge, endCard, music, duration, credits });
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

  // Keep hashtags relevant and valid; never generate ##foo or generic spam tags.
  const hashtagLine = youtubeHashtagLine([
    ...(Array.isArray(script.hashtags) ? script.hashtags : []),
    ...(IS_SHORTS ? ['shorts'] : [])
  ]);
  const series = CFG.category === 'stories'
    ? (CFG.partNumber >= CFG.arcParts
      ? (CFG.arcParts > 1 ? `📺 This is the finale of the story. A brand-new story starts on the next upload — follow so you don't miss it.` : '')
      : `📺 Part ${CFG.partNumber} of ${CFG.arcParts}. Part ${CFG.partNumber + 1} is coming next — follow so you don't miss it.`)
    : '';
  const sourcesBlock = [
    script.sources?.length ? `📰 SOURCES
${script.sources.map((x) => `• ${x}`).join('\n')}` : '',
    script.sourceLinks?.length ? script.sourceLinks.map((u) => `• ${u}`).join('\n') : '',
    script.factChecked ? '✅ Every fact in this video was checked against the sources above before publishing.' : '',
    script.officialUrl ? `🔗 Official site: ${script.officialUrl}` : ''
  ].filter(Boolean).join('\n');
  const creditsBlock = [
    script.imageAttributions?.length
      ? `🖼️ IMAGE CREDITS (images may be cropped)
${script.imageAttributions.map((a) => `• ${a}`).join('\n')}`.slice(0, 1800)
      : '',
    script.imageCredits?.some((c) => c.startsWith('Screenshot:'))
      ? (CFG.category === 'news'
        ? `Screenshots show the source page this story was reported on (${script.imageCredits.filter((c) => c.startsWith('Screenshot:')).map((c) => c.replace('Screenshot: ', '')).join(', ')}).`
        : `Screenshots of ${script.officialUrl ? hostOf(script.officialUrl) : 'the official website'} are shown to explain how to use it.`)
      : '',
    CFG.category !== 'stories' ? '' : 'Story art is original and AI-generated for this video.',
    '🎵 Music: original, composed for this video.'
  ].filter(Boolean).join('\n');
  const description = sanitizeYouTubeDescription([
    script.description || script.title,
    descriptionDetails(script),
    series,
    sourcesBlock,
    creditsBlock,
    hashtagLine
  ].filter(Boolean).join('\n\n').trim());
  // Facebook / Instagram get the same detailed text (Instagram: max 2,200 chars, 30 hashtags).
  const socialText = [script.description, descriptionDetails(script), series, sourcesBlock].filter(Boolean).join('\n\n').trim();

  fs.writeFileSync(OUTPUT_META, JSON.stringify({
    campaignId: CFG.campaignId, partNumber: CFG.partNumber, format: CFG.format, aspect: CFG.aspect,
    title: script.title, description, hashtags: script.hashtags, tags: script.tags, model: script.model,
    scenes: script.scenes.map((s, i) => ({ ...s, start: times[i].start, end: times[i].end, image: images[i] ? path.basename(images[i]!) : null, imageCredit: credits[i] || null })),
    imageSource: CFG.category === 'stories' ? 'generated (animated story art)' : 'real, freely licensed images (public domain / CC0 / CC BY) + official-site screenshots', imageCredits: script.imageCredits || [], imageAttributions: script.imageAttributions || [], officialUrl: script.officialUrl || '',
    cues,
    voice: narration.engine, character: characterMode, durationSec: outDur, createdAt: new Date().toISOString()
  }, null, 2));

  // 5. Publish — YouTube, the Facebook Page and/or its Instagram.
  let published: { videoId: string; url: string; privacy: string } | null = null;
  let facebookUrl = '', instagramUrl = '';
  const failures: { where: string; code: string; message: string }[] = [];
  if (!PUBLISH) {
    log('Publishing is OFF for this automation — the video is saved as a run artifact only.');
  } else if (CFG.dryRun) {
    log(`Dry run — skipping publishing (${Array.from(CFG.targets).join(', ')}).`);
  } else {
    const where = [WANT.youtube && 'YouTube', WANT.facebook && 'Facebook', WANT.instagram && 'Instagram'].filter(Boolean).join(', ');
    await reportStatus('running', `5/5 Publishing to ${where}`, 88, `Uploading the ${IS_SHORTS ? 'Short' : 'video'} to ${where}…`);
    if (WANT.youtube) {
      try {
        published = await uploadToYouTube({ title: script.title, description, tags: script.tags, synthetic: aiCount > 0 });
        log(`Published on YouTube: ${published.url} (privacy: ${published.privacy})`);
      } catch (err: any) {
        // Only YouTube: keep the original behaviour (the error decides retry vs pause).
        if (!WANT.facebook && !WANT.instagram) throw err;
        failures.push({ where: 'YouTube', code: err?.code || 'youtube_upload', message: String(err?.message || err) });
        log(`⚠️ YouTube upload failed: ${err?.message || err}`);
      }
    }
    const social = { pageId: CFG.fbPageId, pageToken: CFG.fbPageToken, igUserId: CFG.igUserId, version: CFG.fbGraphVersion, log };
    const vertical = CFG.aspect === '9:16' || CFG.aspect === '1:1';
    const tagLine = script.hashtags.map((h) => `#${h}`).join(' ');
    if (WANT.facebook) {
      try {
        const fb = await publishToFacebook(social, OUTPUT_VIDEO, { title: script.title, description: `${socialText}\n\n${tagLine}`.trim().slice(0, 5000), vertical });
        facebookUrl = fb.url;
        log(`Published on Facebook: ${fb.url}`);
      } catch (err: any) {
        failures.push({ where: 'Facebook', code: err instanceof SocialError ? err.code : 'facebook_upload', message: String(err?.message || err) });
        log(`⚠️ Facebook upload failed: ${err?.message || err}`);
      }
    }
    if (WANT.instagram) {
      try {
        const ig = await publishToInstagram(social, OUTPUT_VIDEO, { caption: `${script.title}\n\n${socialText}`.slice(0, 2150 - tagLine.length).trim() + `\n\n${tagLine}` });
        instagramUrl = ig.url;
        log(`Published on Instagram: ${ig.url}`);
      } catch (err: any) {
        failures.push({ where: 'Instagram', code: err instanceof SocialError ? err.code : 'facebook_upload', message: String(err?.message || err) });
        log(`⚠️ Instagram upload failed: ${err?.message || err}`);
      }
    }
    if (!published && !facebookUrl && !instagramUrl && failures.length) {
      const auth = failures.find((f) => /auth|not_connected|not_linked/.test(f.code));
      throw new PipelineError(auth?.code || failures[0].code, `Publishing failed everywhere: ${failures.map((f) => `${f.where}: ${f.message}`).join(' | ')}`);
    }
    if (failures.length) await reportStatus('running', '5/5 Published (partly)', 95, `⚠️ Not posted on ${failures.map((f) => `${f.where} (${f.message.slice(0, 120)})`).join(', ')}.`);
  }

  // 6. Report back — the app records the episode and schedules the next one.
  const episode = await appRequest('POST', `${campaignPath()}/episodes`, {
    partNumber: CFG.partNumber, title: script.title, script: fullText, description,
    youtubeUrl: published?.url || '', videoId: published?.videoId || '', published: !!(published || facebookUrl || instagramUrl),
    facebookUrl, instagramUrl,
    privacyStatus: published?.privacy || '', format: CFG.format, aspectRatio: CFG.aspect,
    usedFallbackTemplate: script.usedFallbackTemplate, voice: narration.engine, character: characterMode,
    durationSec: Math.round(outDur), runId: CFG.runId, runUrl: CFG.runUrl,
    sources: script.sources || [], model: script.model || '',
    // Story arc: the app keeps this so the next part continues the same story — and ends it at part ${CFG.arcParts}.
    storyPremise: script.premise || '', storyCharacters: script.characters || '', storyTitle: script.title.replace(/\s*\((part \d+|finale)\)\s*$/i, ''),
    arcPart: CFG.partNumber, arcParts: CFG.arcParts, arcComplete: CFG.category === 'stories' && CFG.partNumber >= CFG.arcParts
  });
  if (CFG.campaignId && CFG.appUrl && (!episode || episode.status >= 300)) {
    console.warn(`⚠️ Could not record the episode in the app (${episode ? `HTTP ${episode.status}` : 'app unreachable'}).`);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const links = [published?.url, facebookUrl, instagramUrl].filter(Boolean);
  await reportStatus('completed', links.length ? 'Published' : 'Video rendered', 100,
    links.length ? `✅ Part ${CFG.partNumber} published in ${secs}s: ${links.join(' · ')}` : `✅ Part ${CFG.partNumber} rendered in ${secs}s (not published).`,
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
