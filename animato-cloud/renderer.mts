/**
 * Animato AutoPoster — cloud renderer (runs on GitHub Actions).
 *
 * One run = one episode:
 *   1. read the job from the repository_dispatch payload
 *   2. ask the app whether the automation still exists / isn't paused
 *   3. write the script (OpenRouter)
 *   4. narrate it (Microsoft Edge neural voices via the `edge-tts` CLI,
 *      ffmpeg's built-in flite voice as a last resort)
 *   5. fetch a background + B-roll images
 *   6. render a 9:16 MP4 with FFmpeg: Ken-Burns background, B-roll
 *      cutscenes, the automation's character with a talking mouth, captions
 *   7. publish to YouTube (resumable upload, refresh-token auth)
 *   8. report the episode back to the app, which schedules the next one
 *
 * Deliberately has ZERO npm dependencies: only Node 22 built-ins + ffmpeg.
 * Run with:  node --experimental-strip-types animato-cloud/renderer.mts
 *
 * The app's server is the scheduler. This script never sleeps or re-triggers
 * itself, so a campaign can always be paused/deleted from the app and no
 * Actions minutes are burned waiting between posts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// Built-in fallbacks so a manually-dispatched run still works.
const DEFAULT_YT_CLIENT_ID = '592242596648-am9pri2j11vmu44fdc6oau5p34aklkj8.apps.googleusercontent.com';
const DEFAULT_OR_ENC = 'c2stb3ItdjEtMTQ4NDgyMjI2ODJjODFlOGE5M2M5OWEzZjM3YTBjMDEzMDNiYjczMzMzMDEwZWEwNzU3Njk3YTFkN2JmZjMxYg==';

const rawGender = pick(JOB.gender, INPUTS.gender, ENV.CHARACTER_GENDER, 'female').toLowerCase();

const CFG = {
  campaignId: pick(CP.campaign_id, INPUTS.campaign_id, ENV.CAMPAIGN_ID),
  partNumber: Math.max(1, parseInt(pick(CP.part_number, INPUTS.part_number, ENV.PART_NUMBER, '1'), 10) || 1),
  appUrl: pick(CP.app_url, INPUTS.app_url, ENV.APP_URL).replace(/\/+$/, ''),
  category: pick(JOB.category, INPUTS.category, ENV.CATEGORY, 'stories').toLowerCase(),
  subGenre: pick(JOB.sub_genre, INPUTS.sub_genre, ENV.SUB_GENRE),
  topic: pick(JOB.topic, INPUTS.topic, ENV.PROMPT, ENV.TOPIC),
  campaignName: pick(JOB.name, ENV.CAMPAIGN_NAME),
  gender: (rawGender === 'male' ? 'male' : 'female') as 'male' | 'female',
  aspect: pick(JOB.aspect_ratio, INPUTS.aspect_ratio, ENV.ASPECT_RATIO, '9:16'),
  autoPost: pick(JOB.auto_post_youtube, INPUTS.auto_post_youtube, ENV.AUTO_POST_YOUTUBE, 'false').toLowerCase() === 'true',
  previousScript: pick(JOB.previous_script, ENV.PREVIOUS_SCRIPT),
  privacy: pick(JOB.privacy, ENV.YOUTUBE_PRIVACY, 'public'),
  ytRefreshToken: pick(AUTH.youtube_refresh_token, ENV.YOUTUBE_REFRESH_TOKEN),
  ytClientId: pick(AUTH.youtube_client_id, ENV.YOUTUBE_CLIENT_ID, DEFAULT_YT_CLIENT_ID),
  ytClientSecret: pick(AUTH.youtube_client_secret, ENV.YOUTUBE_CLIENT_SECRET),
  openrouterKey: pick(AUTH.openrouter_api_key, ENV.OPENROUTER_API_KEY, Buffer.from(DEFAULT_OR_ENC, 'base64').toString('utf8')),
  openrouterModel: pick(JOB.model, ENV.OPENROUTER_MODEL),
  runnerKey: pick(AUTH.runner_key, ENV.ANIMATO_RUNNER_KEY),
  runId: pick(ENV.GITHUB_RUN_ID),
  runUrl: ENV.GITHUB_RUN_ID
    ? `${ENV.GITHUB_SERVER_URL || 'https://github.com'}/${ENV.GITHUB_REPOSITORY}/actions/runs/${ENV.GITHUB_RUN_ID}`
    : '',
  // Test hooks (never set in production).
  dryRun: ENV.ANIMATO_DRY_RUN === 'true',
  offline: ENV.ANIMATO_OFFLINE === 'true',
  openrouterBase: pick(ENV.OPENROUTER_BASE_URL, 'https://openrouter.ai/api/v1'),
  googleTokenUrl: pick(ENV.GOOGLE_TOKEN_URL, 'https://oauth2.googleapis.com/token'),
  youtubeUploadBase: pick(ENV.YOUTUBE_UPLOAD_BASE, 'https://www.googleapis.com/upload/youtube/v3'),
  allowFallbackPublish: ENV.PUBLISH_WITH_FALLBACK_CONTENT === 'true'
};

// Hide every secret from the Actions log before anything can print it.
if (IN_ACTIONS) {
  for (const secret of [CFG.ytRefreshToken, CFG.ytClientSecret, CFG.openrouterKey, CFG.runnerKey]) {
    if (secret && secret.length > 6) console.log(`::add-mask::${secret}`);
  }
}

const OUTPUT_DIR = path.resolve(ENV.ANIMATO_OUTPUT_DIR || path.join(process.cwd(), 'output'));
const WORK_DIR = path.join(OUTPUT_DIR, 'work');
const OUTPUT_VIDEO = path.join(OUTPUT_DIR, 'rendered_video.mp4');
const OUTPUT_META = path.join(OUTPUT_DIR, 'video_metadata.json');
fs.mkdirSync(WORK_DIR, { recursive: true });

const IS_LANDSCAPE = CFG.aspect === '16:9';
const W = IS_LANDSCAPE ? 1920 : 1080;
const H = IS_LANDSCAPE ? 1080 : 1920;
const FPS = 30;

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
      headers: {
        'Content-Type': 'application/json',
        'X-Animato-Runner-Key': CFG.runnerKey || ''
      },
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
    status,
    step,
    progress,
    log: logLine,
    partNumber: CFG.partNumber,
    runId: CFG.runId,
    runUrl: CFG.runUrl,
    ...extra
  });
  if (res && res.status === 401) {
    console.warn('The app rejected the status update (runner key mismatch).');
  }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------
function run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: Buffer; quiet?: boolean } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    let child;
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
      timer = setTimeout(() => {
        err += `\n[timeout after ${opts.timeoutMs}ms]`;
        try { child.kill('SIGKILL'); } catch {}
      }, opts.timeoutMs);
    }
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      err += s;
      if (err.length > 200000) err = err.slice(-100000);
    });
    child.on('error', (e: any) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: err + String(e?.message || e) });
    });
    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

async function probeDuration(file: string): Promise<number> {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(r.stdout.toString().trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

async function isUsableImage(file: string): Promise<boolean> {
  if (!fs.existsSync(file) || fs.statSync(file).size < 1500) return false;
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [w, h] = r.stdout.toString().trim().split(',').map((n) => parseInt(n, 10));
  return r.code === 0 && w >= 200 && h >= 200;
}

// ---------------------------------------------------------------------------
// 1. Script
// ---------------------------------------------------------------------------
interface Cutscene { searchQuery?: string; imagePrompt?: string; startTimePct?: number; duration?: number; triggerPhrase?: string }
interface ScriptResult {
  title: string;
  description: string;
  hashtags: string[];
  script: string;
  backgroundQuery: string;
  cutscenes: Cutscene[];
  usedFallbackTemplate: boolean;
  aiError?: string;
}

function categoryInstruction(pastStory: string): string {
  const topic = CFG.topic ? ` Topic / direction from the creator: "${CFG.topic}".` : '';
  const sub = CFG.subGenre ? ` Sub-genre: ${CFG.subGenre}.` : '';
  if (CFG.category === 'cooking') {
    return `Write a narrated YouTube Short: a real, step-by-step cooking tutorial for one delicious dish.${sub}${topic}
Pick a DIFFERENT dish than the creator's previous videos listed below (if any).
The "script" must be 170-230 spoken words: exact ingredient amounts, clear steps, sensory detail, one plating tip, and a short call to action.`;
  }
  if (CFG.category === 'tech') {
    return `Write a narrated YouTube Short reviewing one real, recent tech product, AI model or hardware release.${sub}${topic}
Pick a DIFFERENT product than the creator's previous videos listed below (if any).
The "script" must be 170-230 spoken words: what it is, what is genuinely good, what is weak, and a clear verdict. Do not invent benchmark numbers.`;
  }
  const continuity = pastStory
    ? `\n\nTHE STORY SO FAR:\n${pastStory}\n\nPart ${CFG.partNumber} MUST continue directly from where the last part ended: same characters, same world, resolve or escalate the last cliffhanger.`
    : '';
  return `Write Part ${CFG.partNumber} of an episodic short story for YouTube Shorts.${sub}${topic}${continuity}
The "script" is the spoken narration only: 130-170 words, first or third person, vivid and tense, ending on a cliffhanger that teases Part ${CFG.partNumber + 1}.
The "title" must end with "(Part ${CFG.partNumber})".`;
}

function templateScript(): ScriptResult {
  const base: ScriptResult = {
    title: '',
    description: '',
    hashtags: [],
    script: '',
    backgroundQuery: '',
    cutscenes: [],
    usedFallbackTemplate: true
  };
  if (CFG.category === 'cooking') {
    return {
      ...base,
      title: 'Garlic Butter Pan-Seared Steak',
      description: 'A simple, restaurant-quality pan-seared steak with garlic butter.',
      hashtags: ['cooking', 'recipe', 'steak'],
      backgroundQuery: 'steak cast iron skillet',
      script: 'Tonight we are making a garlic butter pan-seared steak. Pat a thick ribeye completely dry, then season every side with coarse salt and cracked pepper. Heat a cast iron skillet until it just starts to smoke, add a tablespoon of oil, and lay the steak away from you. Leave it alone for two and a half minutes until a deep brown crust forms. Flip it, then add three tablespoons of butter, four crushed garlic cloves and a sprig of rosemary. Tilt the pan and spoon that foaming butter over the steak again and again. Pull it at one hundred and thirty degrees for medium rare and let it rest for eight minutes before slicing against the grain. Tell me what we should cook next.',
      cutscenes: [
        { searchQuery: 'steak searing cast iron', startTimePct: 0.3, duration: 5 },
        { searchQuery: 'sliced steak cutting board', startTimePct: 0.7, duration: 5 }
      ]
    };
  }
  if (CFG.category === 'tech') {
    return {
      ...base,
      title: 'Is This Flagship Phone Worth It?',
      description: 'An honest take on what matters in a flagship phone.',
      hashtags: ['tech', 'review', 'smartphone'],
      backgroundQuery: 'smartphone technology desk',
      script: 'Is a flagship phone still worth it this year? Here is the honest answer. The biggest real upgrade is the camera: better low light, cleaner zoom and far more reliable video. Performance is the smallest upgrade, because last year\'s chips were already more than fast enough for everything most people do. Battery life has quietly improved, and faster charging makes a real daily difference. Where flagships still fall short is price and repairability. My verdict: if your current phone is three or more years old, upgrade. If not, keep your money and wait one more cycle. Which phone are you using right now?',
      cutscenes: [
        { searchQuery: 'smartphone camera closeup', startTimePct: 0.3, duration: 5 },
        { searchQuery: 'phone battery charging', startTimePct: 0.7, duration: 5 }
      ]
    };
  }
  return {
    ...base,
    title: `The Lighthouse Signal (Part ${CFG.partNumber})`,
    description: 'An episodic mystery told in parts.',
    hashtags: ['story', 'mystery', 'shorts'],
    backgroundQuery: 'lighthouse storm night',
    script: 'For seventy years nobody had tended the lighthouse on Blackwood Point. So when a blue light started pulsing through the fog tonight, I went to look. The rusted door groaned open into total darkness. The air smelled of salt and old stone, and on the spiral stairs I found fresh, wet footprints leading up. Each step echoed louder than it should have. At the top, the great glass lens was turning on its own, humming. And scratched into the glass, in letters still sharp and new, was today\'s date and my name.',
    cutscenes: [
      { searchQuery: 'lighthouse fog night', startTimePct: 0.25, duration: 5 },
      { searchQuery: 'spiral staircase dark', startTimePct: 0.65, duration: 5 }
    ]
  };
}

function extractJson(text: string): any {
  const cleaned = text.replace(/```json/gi, '```').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function generateScript(pastStory: string, pastTitles: string[]): Promise<ScriptResult> {
  const avoid = pastTitles.length ? `\nPrevious video titles (do not repeat these): ${pastTitles.slice(-12).join(' | ')}` : '';
  const userPrompt = `${categoryInstruction(pastStory)}${avoid}

Return ONLY a JSON object with exactly these keys:
{
  "title": "catchy title, max 70 characters",
  "description": "1-2 sentence YouTube description",
  "hashtags": ["3 to 6 single-word hashtags without #"],
  "script": "the spoken narration",
  "backgroundQuery": "3-5 word photo search query for a background image that fits the whole video",
  "cutscenes": [ { "searchQuery": "3-5 word photo search query", "imagePrompt": "one-sentence photo description", "startTimePct": 0.3, "duration": 5 } ]
}
Give 2 or 3 cutscenes spread across the video (startTimePct between 0.15 and 0.85).`;

  const models = [CFG.openrouterModel, 'openai/gpt-4o-mini', 'google/gemini-2.0-flash-001', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat']
    .filter((m, i, arr) => m && arr.indexOf(m) === i);

  let lastError = '';
  if (!CFG.offline) {
    for (const model of models) {
      try {
        const res = await fetch(`${CFG.openrouterBase}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CFG.openrouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': CFG.appUrl || 'https://animato.studio',
            'X-Title': 'Animato AutoPoster'
          },
          body: JSON.stringify({
            model,
            temperature: 0.9,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'You are a professional short-form video writer. You always answer with one valid JSON object and nothing else.' },
              { role: 'user', content: userPrompt }
            ]
          }),
          signal: AbortSignal.timeout(75000)
        });
        const bodyText = await res.text();
        if (!res.ok) {
          lastError = `${model}: HTTP ${res.status} ${bodyText.slice(0, 200)}`;
          log(`OpenRouter ${lastError}`);
          // Auth / credit problems won't be fixed by trying another model.
          if (res.status === 401 || res.status === 402 || res.status === 403) break;
          continue;
        }
        const content = JSON.parse(bodyText)?.choices?.[0]?.message?.content || '';
        const parsed = extractJson(content);
        const script = String(parsed.script || '').replace(/\s+/g, ' ').trim();
        if (script.split(' ').length < 40) {
          lastError = `${model}: script too short`;
          continue;
        }
        log(`Script written by ${model} (${script.split(' ').length} words).`);
        return {
          title: String(parsed.title || `${CFG.category} video`).trim(),
          description: String(parsed.description || '').trim(),
          hashtags: (Array.isArray(parsed.hashtags) ? parsed.hashtags : [])
            .map((h: any) => String(h).replace(/[^a-z0-9]/gi, ''))
            .filter(Boolean)
            .slice(0, 6),
          script,
          backgroundQuery: String(parsed.backgroundQuery || CFG.topic || CFG.category).trim(),
          cutscenes: (Array.isArray(parsed.cutscenes) ? parsed.cutscenes : []).slice(0, 3),
          usedFallbackTemplate: false
        };
      } catch (err: any) {
        lastError = `${model}: ${err?.message}`;
        log(`OpenRouter attempt failed — ${lastError}`);
      }
    }
  } else {
    lastError = 'offline test mode';
  }

  log(`⚠️ AI script generation failed (${lastError}). Using the built-in template script.`);
  return { ...templateScript(), aiError: lastError };
}

// ---------------------------------------------------------------------------
// 2. Narration
// ---------------------------------------------------------------------------
interface Cue { start: number; end: number; text: string }
interface Narration { audioPath: string; duration: number; cues: Cue[]; engine: string; neural: boolean }

const EDGE_VOICES: Record<string, string[]> = {
  female: ['en-US-AriaNeural', 'en-US-JennyNeural', 'en-US-AvaNeural'],
  male: ['en-US-GuyNeural', 'en-US-ChristopherNeural', 'en-US-AndrewNeural']
};

function cleanForSpeech(text: string): string {
  return text
    .replace(/[*_#`>~]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTimestamp(ts: string): number {
  const m = ts.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return (parseInt(m[1] || '0', 10) * 3600) + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

function parseSubtitleFile(file: string): Cue[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  const cues: Cue[] = [];
  for (const block of raw.split(/\n\n+/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const [a, b] = lines[timeIdx].split('-->');
    const text = lines.slice(timeIdx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    cues.push({ start: parseTimestamp(a), end: parseTimestamp(b), text });
  }
  return cues.sort((x, y) => x.start - y.start);
}

async function synthesizeNarration(script: string): Promise<Narration> {
  const text = cleanForSpeech(script);
  const textFile = path.join(WORK_DIR, 'script.txt');
  fs.writeFileSync(textFile, text);

  // 1. Microsoft Edge neural voices through the maintained Python `edge-tts` CLI.
  if (!CFG.offline) {
    for (const voice of EDGE_VOICES[CFG.gender]) {
      const mp3 = path.join(WORK_DIR, 'narration.mp3');
      const srt = path.join(WORK_DIR, 'narration.srt');
      for (const f of [mp3, srt]) { try { fs.unlinkSync(f); } catch {} }
      const r = await run('edge-tts', ['--voice', voice, '--file', textFile, '--write-media', mp3, '--write-subtitles', srt], { timeoutMs: 150000 });
      const duration = fs.existsSync(mp3) ? await probeDuration(mp3) : 0;
      if (r.code === 0 && duration > 2) {
        log(`Narration synthesized with ${voice} (${duration.toFixed(1)}s).`);
        return { audioPath: mp3, duration, cues: parseSubtitleFile(srt), engine: `edge-tts:${voice}`, neural: true };
      }
      log(`edge-tts with ${voice} failed (exit ${r.code}): ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`);
    }
  }

  // 2. Offline fallback: ffmpeg's built-in flite voice (robotic, but never fails).
  const wav = path.join(WORK_DIR, 'narration_flite.wav');
  const voice = CFG.gender === 'male' ? 'kal16' : 'slt';
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `flite=textfile=${textFile}:voice=${voice}`, '-ar', '44100', '-ac', '1', wav], { timeoutMs: 120000 });
  const duration = fs.existsSync(wav) ? await probeDuration(wav) : 0;
  if (r.code !== 0 || duration < 1) {
    throw new PipelineError('tts_failed', `Voice synthesis failed with every engine. Last error: ${r.stderr.slice(-300)}`);
  }
  log(`⚠️ Neural voice unavailable — used the offline flite voice (${duration.toFixed(1)}s).`);
  return { audioPath: wav, duration, cues: [], engine: `flite:${voice}`, neural: false };
}

/** Turn sentence-level (or word-level) cues into short, punchy caption chunks. */
function buildCaptionChunks(script: string, cues: Cue[], duration: number): Cue[] {
  const chunkWords = (text: string) => {
    const words = text.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let cur: string[] = [];
    words.forEach((w, i) => {
      cur.push(w);
      if (cur.length >= 4 || /[.!?,;:]$/.test(w) || i === words.length - 1) {
        out.push(cur.join(' '));
        cur = [];
      }
    });
    return out;
  };
  const spread = (text: string, start: number, end: number): Cue[] => {
    const chunks = chunkWords(text);
    const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let t = start;
    return chunks.map((c) => {
      const d = ((end - start) * c.length) / total;
      const cue = { start: t, end: t + d, text: c };
      t += d;
      return cue;
    });
  };

  const usable = cues.filter((c) => c.end > c.start && c.text);
  if (usable.length > 0) {
    // Merge word-level cues into ~4-word chunks, split long sentence cues.
    const avgWords = usable.reduce((n, c) => n + c.text.split(/\s+/).length, 0) / usable.length;
    if (avgWords <= 1.5) {
      const out: Cue[] = [];
      let buf: Cue[] = [];
      usable.forEach((c, i) => {
        buf.push(c);
        if (buf.length >= 4 || /[.!?,;:]$/.test(c.text) || i === usable.length - 1) {
          out.push({ start: buf[0].start, end: buf[buf.length - 1].end, text: buf.map((b) => b.text).join(' ') });
          buf = [];
        }
      });
      return out;
    }
    return usable.flatMap((c) => spread(c.text, c.start, c.end));
  }
  return spread(cleanForSpeech(script), 0.15, Math.max(1, duration - 0.3));
}

/** Mouth open/closed timeline from the narration's loudness envelope. */
async function buildMouthTimeline(audioPath: string, duration: number): Promise<{ open: boolean; dur: number }[]> {
  const rate = 8000;
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', audioPath, '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { timeoutMs: 120000 });
  const step = 1 / 15;
  const windowSize = Math.floor(rate * step);
  const samples = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 2));
  const levels: number[] = [];
  for (let i = 0; i + windowSize <= samples.length; i += windowSize) {
    let sum = 0;
    for (let j = i; j < i + windowSize; j++) sum += samples[j] * samples[j];
    levels.push(Math.sqrt(sum / windowSize));
  }
  if (levels.length === 0) {
    // Fallback: gentle talking rhythm.
    const out: { open: boolean; dur: number }[] = [];
    for (let t = 0; t < duration; t += 0.24) out.push({ open: out.length % 2 === 1, dur: 0.12 });
    return out;
  }
  const sorted = [...levels].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 1;
  const threshold = loud * 0.28;
  const timeline: { open: boolean; dur: number }[] = [];
  let prevOpen = false;
  levels.forEach((lv, i) => {
    // Alternate on sustained vowels so the mouth keeps moving while talking.
    let open = lv > threshold;
    if (open && prevOpen && i % 3 === 2) open = false;
    const last = timeline[timeline.length - 1];
    if (last && last.open === open) last.dur += step;
    else timeline.push({ open, dur: step });
    prevOpen = open;
  });
  return timeline;
}

// ---------------------------------------------------------------------------
// 3. Images
// ---------------------------------------------------------------------------
async function download(url: string, file: string, timeoutMs = 40000): Promise<boolean> {
  try {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      const meta = url.slice(0, comma);
      const payload = url.slice(comma + 1);
      fs.writeFileSync(file, meta.includes('base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload)));
    } else {
      const res = await fetch(url, { headers: { 'User-Agent': 'AnimatoAutoPoster/3.0' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return false;
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    return await isUsableImage(file);
  } catch {
    return false;
  }
}

const CATEGORY_FALLBACK_PHOTOS: Record<string, string> = {
  cooking: 'https://images.unsplash.com/photo-1556910103-1c02745aae4d?w=1600&q=80&auto=format&fit=crop',
  tech: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=1600&q=80&auto=format&fit=crop',
  stories: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1600&q=80&auto=format&fit=crop'
};

async function findImage(query: string, prompt: string, file: string): Promise<boolean> {
  if (CFG.offline) return false;
  const q = (query || prompt || '').replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return false;

  // a) The app's own multi-source search (same logic the editor uses).
  const viaApp = await appRequest('POST', '/api/automation/search-scene-images', { query: q, prompt: prompt || q, width: W, height: H }, 30000);
  if (viaApp?.status === 200 && viaApp.data?.imageUrl && await download(viaApp.data.imageUrl, file)) return true;

  // b) Openverse (openly licensed photos).
  try {
    const res = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q.split(' ').slice(0, 5).join(' '))}&page_size=8&aspect_ratio=${IS_LANDSCAPE ? 'wide' : 'tall'}`, {
      headers: { 'User-Agent': 'AnimatoAutoPoster/3.0' },
      signal: AbortSignal.timeout(20000)
    });
    if (res.ok) {
      const data: any = await res.json();
      for (const item of data?.results || []) {
        if (item?.url && await download(item.url, file, 25000)) return true;
      }
    }
  } catch {}

  // c) AI image generation (Pollinations).
  const seed = Math.floor(Math.random() * 1e6);
  const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(`${prompt || q}, cinematic photo`)}?width=${W}&height=${H}&nologo=true&seed=${seed}`;
  if (await download(pollUrl, file, 60000)) return true;
  return false;
}

async function makeGradient(file: string, colors: [string, string]) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=${colors[0]}:c1=${colors[1]}:x0=0:y0=0:x1=${W}:y1=${H}:nb_colors=2`, '-frames:v', '1', file]);
}

// ---------------------------------------------------------------------------
// 4. Character sprites
// ---------------------------------------------------------------------------
async function prepareCharacter(): Promise<{ rest: string; open: string; source: string }> {
  // Prefer the character the creator designed in the app.
  const res = await appRequest('GET', `${campaignPath()}/character`, undefined, 30000);
  if (res?.status === 200 && res.data?.rest) {
    const rest = path.join(WORK_DIR, 'char_rest.png');
    const open = path.join(WORK_DIR, 'char_open.png');
    const okRest = await download(res.data.rest, rest);
    const okOpen = res.data.open ? await download(res.data.open, open) : false;
    if (okRest) {
      log('Using the character designed in the app.');
      return { rest, open: okOpen ? open : rest, source: 'app' };
    }
  }
  const dirs = [path.join(HERE, 'assets', 'avatars'), path.join(process.cwd(), 'animato-cloud', 'assets', 'avatars')];
  for (const dir of dirs) {
    const rest = path.join(dir, `${CFG.gender}_rest.png`);
    const open = path.join(dir, `${CFG.gender}_open.png`);
    if (fs.existsSync(rest) && fs.existsSync(open)) return { rest, open, source: 'default' };
  }
  throw new PipelineError('missing_assets', 'No character sprites found (animato-cloud/assets/avatars is missing).');
}

// ---------------------------------------------------------------------------
// 5. Captions (ASS)
// ---------------------------------------------------------------------------
function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function assEscape(text: string): string {
  return text.replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\n/g, ' ');
}

function writeAss(file: string, captions: Cue[], title: string, badge: string, duration: number) {
  const captionSize = Math.round(H * 0.041);
  const badgeSize = Math.round(H * 0.024);
  const titleSize = Math.round(H * 0.036);
  const captionMarginV = Math.round(H * (IS_LANDSCAPE ? 0.12 : 0.52));
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,DejaVu Sans,${captionSize},&H0015CCFA,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${Math.round(captionSize * 0.12)},3,2,70,70,${captionMarginV},1
Style: Badge,DejaVu Sans,${badgeSize},&H00FFFFFF,&H00FFFFFF,&H00120C0C,&H3A120C0C,-1,0,0,0,100,100,2,0,3,${Math.round(badgeSize * 0.55)},0,8,40,40,${Math.round(H * 0.05)},1
Style: Title,DejaVu Sans,${titleSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${Math.round(titleSize * 0.1)},3,8,80,80,${Math.round(H * 0.11)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines: string[] = [];
  lines.push(`Dialogue: 2,${assTime(0)},${assTime(duration)},Badge,,0,0,0,,${assEscape(badge)}`);
  lines.push(`Dialogue: 1,${assTime(0)},${assTime(Math.min(3, duration))},Title,,0,0,0,,{\\fad(200,300)}${assEscape(title)}`);
  for (const c of captions) {
    lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,{\\fad(60,60)}${assEscape(c.text.toUpperCase())}`);
  }
  fs.writeFileSync(file, header + lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// 6. Render
// ---------------------------------------------------------------------------
async function findMusic(): Promise<string | null> {
  const track = CFG.category === 'cooking' ? 'motivation_inspirational.mp3'
    : CFG.category === 'tech' ? 'news_broadcast.mp3'
    : /horror|scary|suspense|mystery/i.test(CFG.subGenre) ? 'mystery_suspense.mp3'
    : 'story_chill.mp3';
  const candidates = [
    path.join(HERE, 'music', track),
    path.join(process.cwd(), 'animato-cloud', 'music', track),
    path.join(process.cwd(), 'public', 'audio', 'music', track)
  ];
  const local = candidates.find((c) => fs.existsSync(c));
  if (local) return local;
  // The tracks ship with the app, so fetch the one we need from it.
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

function kenBurns(inputLabel: string, outLabel: string, frames: number, zoomTo: number, driftSeed: number): string {
  // Cover the frame, then a slow zoom with a gentle sideways drift.
  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H},setsar=1`;
  const rate = ((zoomTo - 1) / Math.max(1, frames)).toFixed(6);
  const dx = driftSeed % 2 === 0 ? '+' : '-';
  return `${inputLabel}${cover},zoompan=z='min(1+${rate}*on,${zoomTo})':x='iw/2-(iw/zoom/2)${dx}(iw/zoom/14)*(on/${Math.max(1, frames)})':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}${outLabel}`;
}

async function renderVideo(opts: {
  narration: Narration;
  captions: Cue[];
  title: string;
  badge: string;
  background: string;
  cutscenes: { file: string; start: number; end: number }[];
  character: { rest: string; open: string };
  mouth: { open: boolean; dur: number }[];
}) {
  const duration = opts.narration.duration + 0.8;
  const frames = Math.ceil(duration * FPS);

  // Talking-character track (concat of rest/open sprites timed to the voice).
  const concatFile = path.join(WORK_DIR, 'mouth.ffconcat');
  const concatLines = ['ffconcat version 1.0'];
  let acc = 0;
  for (const seg of opts.mouth) {
    concatLines.push(`file '${seg.open ? opts.character.open : opts.character.rest}'`);
    concatLines.push(`duration ${seg.dur.toFixed(4)}`);
    acc += seg.dur;
  }
  if (acc < duration) {
    concatLines.push(`file '${opts.character.rest}'`);
    concatLines.push(`duration ${(duration - acc + 0.5).toFixed(4)}`);
  }
  concatLines.push(`file '${opts.character.rest}'`);
  fs.writeFileSync(concatFile, concatLines.join('\n') + '\n');

  const assFile = path.join(WORK_DIR, 'captions.ass');
  writeAss(assFile, opts.captions, opts.title, opts.badge, duration);

  // Character size: busts ~50% of the frame height, full bodies a bit taller.
  const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', opts.character.rest]);
  const [cw, ch] = probe.stdout.toString().trim().split(',').map((n) => parseInt(n, 10));
  const tall = ch && cw ? ch / cw > 1.6 : false;
  const charH = Math.round(H * (IS_LANDSCAPE ? 0.72 : tall ? 0.6 : 0.5));

  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-stats', '-y'];
  args.push('-loop', '1', '-framerate', String(FPS), '-t', duration.toFixed(3), '-i', opts.background);
  for (const c of opts.cutscenes) args.push('-loop', '1', '-framerate', String(FPS), '-t', (c.end - c.start).toFixed(3), '-i', c.file);
  const charIdx = 1 + opts.cutscenes.length;
  args.push('-f', 'concat', '-safe', '0', '-i', concatFile);
  const voiceIdx = charIdx + 1;
  args.push('-i', opts.narration.audioPath);
  const music = await findMusic();
  const musicIdx = music ? voiceIdx + 1 : -1;
  if (music) args.push('-stream_loop', '-1', '-i', music);

  const f: string[] = [];
  f.push(kenBurns('[0:v]', '[bgz]', frames, 1.12, CFG.partNumber) + '');
  f.push(`[bgz]eq=brightness=-0.05:saturation=1.08,vignette=PI/5[bg0]`);
  let current = '[bg0]';

  // Character hidden while a full-screen cutscene is on.
  const hideExpr = opts.cutscenes.length
    ? `:enable='not(${opts.cutscenes.map((c) => `between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})`).join('+')})'`
    : '';
  f.push(`[${charIdx}:v]fps=${FPS},format=rgba,scale=-2:${charH}:flags=lanczos[char]`);
  f.push(`${current}[char]overlay=x='(W-w)/2':y='H-h+18+12*sin(2*PI*t/3.4)':eval=frame${hideExpr}[withchar]`);
  current = '[withchar]';

  // Each cutscene stream only exists for its own window (cheap), shifted into place.
  opts.cutscenes.forEach((c, i) => {
    const idx = i + 1;
    const len = c.end - c.start;
    const cf = Math.ceil(len * FPS);
    f.push(kenBurns(`[${idx}:v]`, `[cz${i}]`, cf, 1.16, i + 3));
    f.push(`[cz${i}]format=rgba,fade=t=in:st=0:d=0.35:alpha=1,fade=t=out:st=${Math.max(0, len - 0.35).toFixed(2)}:d=0.35:alpha=1,setpts=PTS-STARTPTS+${c.start.toFixed(3)}/TB[cut${i}]`);
    f.push(`${current}[cut${i}]overlay=0:0:eof_action=pass[v${i}]`);
    current = `[v${i}]`;
  });

  f.push(`${current}ass=filename='${assFile.replace(/'/g, "\\'")}',format=yuv420p[vout]`);

  if (music) {
    f.push(`[${voiceIdx}:a]aresample=48000,apad[voice]`);
    f.push(`[${musicIdx}:a]aresample=48000,volume=0.13[music]`);
    f.push(`[voice][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
  } else {
    f.push(`[${voiceIdx}:a]aresample=48000,apad[aout]`);
  }

  args.push('-filter_complex', f.join(';'));
  args.push('-map', '[vout]', '-map', '[aout]', '-t', duration.toFixed(3), '-r', String(FPS));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-profile:v', 'high');
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', OUTPUT_VIDEO);

  log(`Rendering ${W}x${H} ${duration.toFixed(1)}s video (${opts.cutscenes.length} cutscenes, music: ${music ? path.basename(music) : 'none'})…`);
  const started = Date.now();
  const r = await run('ffmpeg', args, { timeoutMs: 20 * 60 * 1000 });
  if (r.code !== 0 || !fs.existsSync(OUTPUT_VIDEO)) {
    throw new PipelineError('render_failed', `FFmpeg failed (exit ${r.code}): ${r.stderr.trim().split('\n').slice(-6).join(' | ')}`);
  }
  const outDur = await probeDuration(OUTPUT_VIDEO);
  log(`Rendered in ${((Date.now() - started) / 1000).toFixed(0)}s → ${(fs.statSync(OUTPUT_VIDEO).size / 1e6).toFixed(1)} MB, ${outDur.toFixed(1)}s.`);
  if (outDur < 3) throw new PipelineError('render_failed', `Rendered video is only ${outDur.toFixed(1)}s long.`);
}

// ---------------------------------------------------------------------------
// 7. YouTube
// ---------------------------------------------------------------------------
let cachedYouTubeToken = '';

async function youtubeAccessToken(): Promise<string> {
  if (cachedYouTubeToken) return cachedYouTubeToken;
  if (!CFG.ytRefreshToken) {
    throw new PipelineError('youtube_not_connected', 'No YouTube account is connected to this automation. Open its dashboard and press "Connect YouTube".');
  }
  if (!CFG.ytClientSecret) {
    throw new PipelineError('youtube_config', 'The YouTube OAuth client secret was not provided to the runner.');
  }
  const res = await fetch(CFG.googleTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CFG.ytClientId,
      client_secret: CFG.ytClientSecret,
      refresh_token: CFG.ytRefreshToken,
      grant_type: 'refresh_token'
    }).toString(),
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

const YT_CATEGORY: Record<string, string> = { cooking: '26', tech: '28', stories: '24' };

async function uploadToYouTube(meta: { title: string; description: string; tags: string[] }): Promise<{ videoId: string; url: string; privacy: string }> {
  const token = await youtubeAccessToken();
  const bytes = fs.readFileSync(OUTPUT_VIDEO);
  let title = meta.title.replace(/[<>]/g, '').trim() || 'New video';
  if (!IS_LANDSCAPE && !/#shorts/i.test(title) && title.length <= 90) title += ' #Shorts';
  title = title.slice(0, 100);
  const body = {
    snippet: {
      title,
      description: meta.description.slice(0, 4900),
      tags: meta.tags.slice(0, 15),
      categoryId: YT_CATEGORY[CFG.category] || '24'
    },
    status: { privacyStatus: CFG.privacy, selfDeclaredMadeForKids: false }
  };

  const init = await fetch(`${CFG.youtubeUploadBase}/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(bytes.length),
      'X-Upload-Content-Type': 'video/mp4'
    },
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
      const put = await fetch(location, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4' },
        body: bytes,
        signal: AbortSignal.timeout(10 * 60 * 1000)
      });
      const text = await put.text();
      if (put.ok) {
        const data = JSON.parse(text || '{}');
        const videoId = data.id;
        if (!videoId) throw new Error('upload finished without a video id');
        const url = IS_LANDSCAPE ? `https://www.youtube.com/watch?v=${videoId}` : `https://youtube.com/shorts/${videoId}`;
        return { videoId, url, privacy: data?.status?.privacyStatus || CFG.privacy };
      }
      lastErr = `HTTP ${put.status}: ${text.slice(0, 300)}`;
      if (put.status < 500) break;
    } catch (err: any) {
      lastErr = err?.message || String(err);
    }
    await new Promise((r) => setTimeout(r, attempt * 5000));
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
  console.log(`campaign=${CFG.campaignId || '(none)'} part=${CFG.partNumber} category=${CFG.category} gender=${CFG.gender} autoPost=${CFG.autoPost}`);
  console.log('='.repeat(64));

  // 0. Is this automation still wanted?
  let pastStory = CFG.previousScript ? `PART ${CFG.partNumber - 1}:\n${CFG.previousScript}` : '';
  let pastTitles: string[] = [];
  if (CFG.campaignId && CFG.appUrl) {
    const camp = await appRequest('GET', campaignPath());
    if (camp?.status === 404) {
      log('This automation was deleted in the app — nothing to do.');
      return 0;
    }
    if (camp?.status === 200 && camp.data?.campaign?.status === 'paused') {
      log('This automation is paused in the app — skipping this run.');
      await reportStatus('skipped', 'Skipped (automation paused)', 0, 'Run skipped because the automation is paused.');
      return 0;
    }
    if (!camp) log('⚠️ The app is not reachable from GitHub right now — continuing without live status updates.');

    const hist = await appRequest('GET', `${campaignPath()}/history`);
    const episodes: any[] = Array.isArray(hist?.data?.storyHistory) ? hist!.data.storyHistory : [];
    pastTitles = episodes.map((e) => String(e.title || '')).filter(Boolean);
    if (CFG.category === 'stories' && episodes.length) {
      pastStory = episodes
        .filter((e) => Number(e.partNumber) < CFG.partNumber)
        .slice(-4)
        .map((e) => `PART ${e.partNumber} — ${e.title}:\n${String(e.script || '').slice(0, 1500)}`)
        .join('\n\n') || pastStory;
    }
  }

  await reportStatus('running', '1/5 Writing the script', 10, `GitHub runner started Part ${CFG.partNumber}.`);

  // Fail fast (before spending render minutes) if YouTube posting can't work.
  if (CFG.autoPost && !CFG.dryRun) {
    await youtubeAccessToken();
    log('YouTube connection verified.');
  }

  // 1. Script
  const script = await generateScript(pastStory, pastTitles);
  if (script.usedFallbackTemplate && !CFG.allowFallbackPublish) {
    // A canned template would repeat the same video every run (and break story
    // continuity), so stop here instead of spending minutes rendering it.
    throw new PipelineError('script_failed', `AI script generation failed (${script.aiError || 'unknown error'}). Check the OpenRouter API key / credits. Nothing was posted.`);
  }
  await reportStatus('running', '2/5 Recording the voice-over', 25, `Script ready: "${script.title}".`);

  // 2. Voice
  const narration = await synthesizeNarration(script.script);
  if (!narration.neural && CFG.autoPost && !CFG.allowFallbackPublish) {
    throw new PipelineError('tts_failed', 'The neural voice service (Microsoft Edge TTS) was unreachable from GitHub, so only a robotic fallback voice was available. Nothing was posted; the next run will retry.');
  }
  const captions = buildCaptionChunks(script.script, narration.cues, narration.duration);
  const mouth = await buildMouthTimeline(narration.audioPath, narration.duration);
  await reportStatus('running', '3/5 Finding background & B-roll images', 40, `Voice-over recorded (${narration.duration.toFixed(0)}s, ${narration.engine}).`);

  // 3. Images
  const bgFile = path.join(WORK_DIR, 'background.img');
  let haveBg = await findImage(script.backgroundQuery || CFG.topic || CFG.category, script.backgroundQuery, bgFile);
  if (!haveBg && !CFG.offline) {
    haveBg = await download(CATEGORY_FALLBACK_PHOTOS[CFG.category] || CATEGORY_FALLBACK_PHOTOS.stories, bgFile);
  }
  let background = bgFile;
  if (!haveBg) {
    background = path.join(WORK_DIR, 'background_gradient.png');
    await makeGradient(background, CFG.category === 'cooking' ? ['0x3b1d0f', '0x9a4a12'] : CFG.category === 'tech' ? ['0x061a2b', '0x0f4c75'] : ['0x0b0b1a', '0x3a1c4a']);
  }

  const cutscenes: { file: string; start: number; end: number }[] = [];
  const total = narration.duration;
  const planned = (script.cutscenes || []).slice(0, 3);
  for (let i = 0; i < planned.length; i++) {
    const c = planned[i];
    const file = path.join(WORK_DIR, `cutscene_${i}.img`);
    if (!(await findImage(String(c.searchQuery || ''), String(c.imagePrompt || ''), file))) continue;
    const pct = Number(c.startTimePct);
    let start = Number.isFinite(pct) && pct > 0 && pct < 1 ? pct * total : ((i + 1) / (planned.length + 1)) * total;
    const dur = Math.min(Math.max(Number(c.duration) || 4.5, 3), 7);
    start = Math.max(3.2, Math.min(start, total - dur - 0.5));
    const prev = cutscenes[cutscenes.length - 1];
    if (prev && start < prev.end + 2) start = prev.end + 2;
    if (start + dur > total - 0.3) continue;
    cutscenes.push({ file, start, end: start + dur });
  }
  await reportStatus('running', '4/5 Rendering the video', 55, `Images ready (${haveBg ? 'photo' : 'gradient'} background, ${cutscenes.length} cutscenes).`);

  // 4. Render
  const character = await prepareCharacter();
  const badge = CFG.category === 'cooking' ? ' HOW TO COOK ' : CFG.category === 'tech' ? ' TECH REVIEW ' : ` PART ${CFG.partNumber} `;
  await renderVideo({ narration, captions, title: script.title, badge, background, cutscenes, character, mouth });

  const hashtags = Array.from(new Set([...(script.hashtags || []), CFG.category, 'shorts'])).filter(Boolean);
  const description = [
    script.description || script.title,
    '',
    CFG.category === 'stories' ? `Part ${CFG.partNumber}. Follow for Part ${CFG.partNumber + 1}.` : '',
    '',
    hashtags.map((h) => `#${h}`).join(' ')
  ].filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n').trim();

  const metadata = {
    campaignId: CFG.campaignId,
    partNumber: CFG.partNumber,
    title: script.title,
    description,
    hashtags,
    script: script.script,
    category: CFG.category,
    voice: narration.engine,
    character: character.source,
    durationSec: narration.duration,
    usedFallbackTemplate: script.usedFallbackTemplate,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(OUTPUT_META, JSON.stringify(metadata, null, 2));

  // 5. Publish
  let published: { videoId: string; url: string; privacy: string } | null = null;
  if (!CFG.autoPost) {
    log('Auto-post is OFF for this automation — the video is saved as a run artifact only.');
  } else if (CFG.dryRun) {
    log('Dry run — skipping the YouTube upload.');
  } else {
    await reportStatus('running', '5/5 Uploading to YouTube', 85, 'Uploading the video to YouTube…');
    published = await uploadToYouTube({ title: script.title, description, tags: hashtags });
    log(`Published: ${published.url} (privacy: ${published.privacy})`);
  }

  // 6. Report back — the app records the episode and schedules the next one.
  const episode = await appRequest('POST', `${campaignPath()}/episodes`, {
    partNumber: CFG.partNumber,
    title: script.title,
    script: script.script,
    description,
    youtubeUrl: published?.url || '',
    videoId: published?.videoId || '',
    published: !!published,
    privacyStatus: published?.privacy || '',
    usedFallbackTemplate: script.usedFallbackTemplate,
    voice: narration.engine,
    durationSec: Math.round(narration.duration),
    runId: CFG.runId,
    runUrl: CFG.runUrl
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
